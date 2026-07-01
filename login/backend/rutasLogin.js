const express = require("express");
const mongoose = require("mongoose");

const bcrypt = require("bcryptjs");

const jwt = require("jsonwebtoken");

const Usuario = require("./modeloUsuario");


const Categoria = require("./modeloCategoria");                        
const CategoriaPersonalizada = require("./modeloCategoriaPersonalizada");
const Cuenta = require("./modeloCuenta");
const Movimiento = require("./modeloMovimiento");
const {
  obtenerRangoMes,
  calcularEstadoPresupuesto
} = require("./servicioPresupuesto");



const enviarCorreo = require("./enviarCorreo");

const verificarToken =
  require("./middleware");

require("dotenv").config();

const router = express.Router();

function esObjectId(valor) {
  return mongoose.Types.ObjectId.isValid(valor);
}

function objectId(valor) {
  return new mongoose.Types.ObjectId(valor);
}

function normalizarMovimiento(movimiento, cuenta = null) {
  const id = movimiento.movimientoExternoId || movimiento._id.toString();
  return {
    id,
    _id: movimiento._id,
    usuarioId: movimiento.usuarioId,
    cuentaId: movimiento.cuentaId,
    cuentaNombre: cuenta?.nombre || movimiento.cuentaId?.nombre || "",
    amount: movimiento.monto,
    monto: movimiento.monto,
    description: movimiento.descripcion,
    descripcion: movimiento.descripcion,
    post_date: movimiento.fecha,
    fecha: movimiento.fecha,
    type: movimiento.tipoBanco || movimiento.origen,
    origen: movimiento.origen,
    movimientoExternoId: movimiento.movimientoExternoId,
    categoriaId: movimiento.categoriaId
  };
}

async function obtenerBalanceTotalCuentas(usuarioId) {
  const cuentas = await Cuenta.find({ usuarioId });
  const saldos = await Promise.all(cuentas.map(async (cuenta) => {
    if (cuenta.tipo === "bancaria") {
      return cuenta.saldo ?? cuenta.saldoBanco ?? 0;
    }

    return calcularSaldoManual(cuenta);
  }));

  return saldos.reduce((sum, saldo) => sum + saldo, 0);
}

function construirResumen(movimientos, balance = 0) {
  const totalIngresos = movimientos
    .filter((m) => m.monto > 0)
    .reduce((sum, m) => sum + m.monto, 0);

  const totalGastos = movimientos
    .filter((m) => m.monto < 0)
    .reduce((sum, m) => sum + Math.abs(m.monto), 0);

  return {
    totalIngresos,
    totalGastos,
    balance,
    cantidadMovimientos: movimientos.length
  };
}

async function calcularSaldoManual(cuenta) {
  const resultado = await Movimiento.aggregate([
    { $match: { cuentaId: cuenta._id } },
    { $group: { _id: "$cuentaId", total: { $sum: "$monto" } } }
  ]);

  return (cuenta.saldoInicial || 0) + (resultado[0]?.total || 0);
}

async function formatearCuenta(cuenta) {
  const saldo = cuenta.tipo === "bancaria"
    ? cuenta.saldo ?? cuenta.saldoBanco
    : await calcularSaldoManual(cuenta);

  return {
    id: cuenta._id.toString(),
    _id: cuenta._id,
    nombre: cuenta.nombre,
    tipo: cuenta.tipoCuenta,
    tipoCuenta: cuenta.tipoCuenta,
    tipoOrigen: cuenta.tipo,
    fintocAccountId: cuenta.fintocAccountId,
    numero: cuenta.numero || (cuenta.tipo === "manual" ? "Manual" : "S/N"),
    saldo,
    moneda: cuenta.moneda,
    manual: cuenta.tipo === "manual"
  };
}

async function obtenerCuentasFintoc(usuario) {
  if (!usuario.linkToken) return [];

  const response = await fetch(
    `https://api.fintoc.com/v1/accounts?link_token=${usuario.linkToken}`,
    { headers: { Authorization: process.env.FINTOC_SECRET_KEY } }
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "Error obteniendo cuentas Fintoc");
  }

  return Array.isArray(data) ? data : [];
}

async function tokenSigueValido(usuarioId) {
  const usuarioActual = await Usuario.findById(usuarioId).select("linkToken");
  return !!(usuarioActual && usuarioActual.linkToken);
}

async function sincronizarCuentasFintoc(usuario) {
  const cuentasFintoc = await obtenerCuentasFintoc(usuario);

  // Revalidación anti-race-condition: entre el fetch a Fintoc (red externa, lento)
  // y este punto, pudo haberse ejecutado /fintoc/desconectar en paralelo y limpiar
  // el linkToken del usuario en la DB. Si eso pasó, abortamos sin escribir nada,
  // para no recrear cuentas/movimientos que ya fueron borrados intencionalmente.
  if (!(await tokenSigueValido(usuario._id))) {
    console.log("sincronizarCuentasFintoc: linkToken vacío al momento de escribir, abortando sync (probable desconexión concurrente)");
    return [];
  }

  const cuentas = [];

  for (const cuenta of cuentasFintoc) {
    const saldo = cuenta.balance?.available ?? cuenta.balance?.current ?? 0;
    const ahora = new Date();
    const cuentaExistente = await Cuenta.findOne({
      usuarioId: usuario._id,
      fintocAccountId: cuenta.id
    }).select("fechaConexion createdAt");
    const fechaConexion = cuentaExistente?.fechaConexion || cuentaExistente?.createdAt || ahora;

    const cuentaDb = await Cuenta.findOneAndUpdate(
      { usuarioId: usuario._id, fintocAccountId: cuenta.id },
      {
        $set: {
          usuarioId: usuario._id,
          nombre: cuenta.name || cuenta.official_name || "Cuenta bancaria",
          tipo: "bancaria",
          tipoCuenta: cuenta.type || "bank_account",
          fintocAccountId: cuenta.id,
          numero: cuenta.number || null,
          moneda: cuenta.currency || "CLP",
          saldo,
          saldoBanco: saldo,
          fechaConexion
        },
        $setOnInsert: {
          saldoInicial: saldo
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await Movimiento.deleteMany({
      usuarioId: usuario._id,
      cuentaId: cuentaDb._id,
      tipoBanco: "saldo_inicial"
    });

    cuentas.push(cuentaDb);
  }

  return cuentas;
}

async function sincronizarMovimientosFintoc(usuario) {
  const cuentas = await sincronizarCuentasFintoc(usuario);
  let importados = 0;

  for (const cuenta of cuentas) {
    // Revalidación 1: antes del fetch a Fintoc (red externa, puede tardar varios
    // segundos). Si el usuario desconectó el banco mientras tanto, no seguimos.
    if (!(await tokenSigueValido(usuario._id))) {
      console.log("sincronizarMovimientosFintoc: linkToken vacío antes de pedir movimientos, abortando (desconexión concurrente)");
      break;
    }

    const movRes = await fetch(
      `https://api.fintoc.com/v1/accounts/${cuenta.fintocAccountId}/movements?link_token=${usuario.linkToken}&per_page=100`,
      { headers: { Authorization: process.env.FINTOC_SECRET_KEY } }
    );

    const movimientos = await movRes.json();
    if (!movRes.ok) {
      throw new Error(movimientos.error?.message || "Error obteniendo movimientos Fintoc");
    }

    // Revalidación 2: justo después de la respuesta de Fintoc, antes de insertar
    // nada en la DB. Esta es la ventana que realmente dejaba huérfanos: la cuenta
    // ya se había revalidado en sincronizarCuentasFintoc, pero este fetch de
    // movimientos es otra llamada de red aparte, sin chequeo propio.
    if (!(await tokenSigueValido(usuario._id))) {
      console.log("sincronizarMovimientosFintoc: linkToken vacío después de la respuesta de Fintoc, descartando lote (desconexión concurrente)");
      break;
    }

    for (const movimiento of movimientos) {
      const fechaMovimiento = new Date(movimiento.post_date || movimiento.transaction_date || 0);

      // Ignoramos movimientos anteriores a la conexión: desde ese momento
      // empiezan a afectar ingresos y gastos dentro de la app.
      if (cuenta.fechaConexion && fechaMovimiento < cuenta.fechaConexion) {
        continue;
      }

      const existe = await Movimiento.exists({
        usuarioId: usuario._id,
        movimientoExternoId: movimiento.id
      });

      if (existe) continue;

      await Movimiento.create({
        usuarioId: usuario._id,
        cuentaId: cuenta._id,
        monto: movimiento.amount,
        descripcion: movimiento.description || "Movimiento bancario",
        categoriaId: null,
        fecha: movimiento.post_date || movimiento.transaction_date || new Date(),
        origen: "banco",
        movimientoExternoId: movimiento.id,
        tipoBanco: movimiento.type || null
      });

      importados += 1;
    }
  }

  return { cuentas: cuentas.length, importados };
}

async function migrarCuentasManuales(usuario) {
  if (!usuario.cuentasManuales?.length) return;

  for (const cuenta of usuario.cuentasManuales) {
    await Cuenta.findOneAndUpdate(
      {
        usuarioId: usuario._id,
        tipo: "manual",
        nombre: cuenta.nombre,
        tipoCuenta: cuenta.tipo || "other"
      },
      {
        usuarioId: usuario._id,
        nombre: cuenta.nombre,
        tipo: "manual",
        tipoCuenta: cuenta.tipo || "other",
        saldo: Number(cuenta.saldo || 0),
        saldoInicial: Number(cuenta.saldo || 0),
        moneda: cuenta.moneda || "CLP",
        createdAt: cuenta.creadaEn || new Date()
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
}

async function crearFiltroMovimientos(query) {
  const {
    usuarioId,
    origen,
    cuentaId,
    categoria,
    fechaInicio,
    fechaFin,
    desde,
    hasta
  } = query;

  const filtro = { usuarioId };

  if (origen && origen !== "todos") filtro.origen = origen;
  if (cuentaId && cuentaId !== "todas") filtro.cuentaId = cuentaId;

  const inicio = fechaInicio || desde;
  const fin = fechaFin || hasta;
  if (inicio || fin) {
    filtro.fecha = {};
    if (inicio) filtro.fecha.$gte = new Date(inicio);
    if (fin) filtro.fecha.$lte = new Date(`${fin}T23:59:59.999Z`);
  }

  if (categoria && categoria !== "todas") {
    if (categoria === "sin_categoria") {
      const categoriasAsignadas = await Categoria.find({ usuarioId });
      const externosAsignados = categoriasAsignadas.map((cat) => cat.movimientoId);
      const idsAsignados = externosAsignados.filter(esObjectId).map(objectId);

      filtro.categoriaId = { $in: [null, "", "sin_categoria"] };
      filtro.movimientoExternoId = { $nin: externosAsignados };
      if (idsAsignados.length) filtro._id = { $nin: idsAsignados };

      return filtro;
    }

    const categorias = await Categoria.find({
      usuarioId,
      $or: [
        { categoria },
        { categoriaPersonalizada: categoria }
      ]
    });
    const externos = categorias.map((cat) => cat.movimientoId);
    const ids = externos.filter(esObjectId).map(objectId);

    filtro.$or = [
      { movimientoExternoId: { $in: externos } },
      { categoriaId: categoria }
    ];

    if (ids.length) filtro.$or.push({ _id: { $in: ids } });
  }

  return filtro;
}

async function obtenerMovimientosFiltrados(query) {
  const filtro = await crearFiltroMovimientos(query);
  filtro.tipoBanco = { $ne: "saldo_inicial" };

  return Movimiento.find(filtro)
    .populate("cuentaId")
    .sort({ fecha: -1, createdAt: -1 });
}

function soloGastos(movimientos) {
  return movimientos.filter((mov) => mov.monto < 0);
}

async function obtenerMapaCategorias(usuarioId) {
  const categorias = await Categoria.find({ usuarioId });
  const mapa = new Map();

  categorias.forEach((cat) => {
    const nombre = cat.categoria === "otro"
      ? cat.categoriaPersonalizada || "otro"
      : cat.categoria;

    mapa.set(cat.movimientoId, nombre);
  });

  return mapa;
}

function obtenerCategoriaMovimiento(movimiento, mapaCategorias) {
  const idNormalizado = movimiento.movimientoExternoId || movimiento._id.toString();
  return mapaCategorias.get(idNormalizado)
    || movimiento.categoriaId
    || "sin_categoria";
}

function sumarMovimientos(movimientos, balance = 0) {
  const ingresosTotales = movimientos
    .filter((mov) => mov.monto > 0)
    .reduce((sum, mov) => sum + mov.monto, 0);

  const gastosTotales = movimientos
    .filter((mov) => mov.monto < 0)
    .reduce((sum, mov) => sum + Math.abs(mov.monto), 0);

  return {
    ingresosTotales,
    gastosTotales,
    balance
  };
}

function idsCategoriaMovimientos(movimientos) {
  return movimientos.flatMap((movimiento) => {
    const ids = [movimiento._id.toString()];
    if (movimiento.movimientoExternoId) ids.push(movimiento.movimientoExternoId);
    return ids;
  });
}

async function eliminarCategoriasDeMovimientos(usuarioId, movimientos) {
  const movimientoIds = idsCategoriaMovimientos(movimientos);
  if (!movimientoIds.length) return 0;

  const resultado = await Categoria.deleteMany({
    usuarioId: usuarioId.toString(),
    movimientoId: { $in: movimientoIds }
  });

  return resultado.deletedCount || 0;
}



// LOG GENERAL
router.use((req, res, next) => {
  console.log("➡️ Ruta:", req.method, req.url);
  next();
});



// =========================
// REGISTRO
// =========================
router.post("/registro", async (req, res) => {

  try {

    const {
      nombre,
      correo,
      contraseña,
    } = req.body;



    const existeUsuario =
      await Usuario.findOne({ correo });



    if (existeUsuario) {

      return res.status(400).json({
        mensaje: "Este correo ya está registrado",
      });

    }



    const contraseñaEncriptada =
      await bcrypt.hash(contraseña, 10);



    const nuevoUsuario =
      new Usuario({

        nombre,
        correo,
        contraseña: contraseñaEncriptada,

      });



    await nuevoUsuario.save();



    res.status(201).json({
      mensaje: "Usuario registrado correctamente",
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      mensaje: "Error del servidor",
    });

  }

});



// =========================
// LOGIN
// =========================
router.post("/login", async (req, res) => {

  try {

    const {
      correo,
      contraseña,
    } = req.body;



    const usuario =
      await Usuario.findOne({ correo });



    if (!usuario) {

      return res.status(404).json({
        mensaje: "No existe un usuario registrado con ese correo",
      });

    }



    const contraseñaCorrecta =
      await bcrypt.compare(
        contraseña,
        usuario.contraseña
      );



    if (!contraseñaCorrecta) {

      return res.status(401).json({
        mensaje: "Correo o contraseña incorrectos",
      });

    }



    const token = jwt.sign(
      {
        id: usuario._id,
        rol: usuario.rol,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );



    res.json({
    mensaje: "Login exitoso",
    token,

    usuario: {
      id: usuario._id,
      nombre: usuario.nombre,
      apellido: usuario.apellido,
      correo: usuario.correo,
      rol: usuario.rol
    }
  });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      mensaje: "Error del servidor",
    });

  }

});



// =========================
// SOLICITAR RECUPERACIÓN
// =========================
router.post("/solicitar-recuperacion", async (req, res) => {

  try {

    const { correo } = req.body;



    if (!correo) {

      return res.status(400).json({
        mensaje: "Debes ingresar un correo",
      });

    }



    const usuario =
      await Usuario.findOne({ correo });



    if (!usuario) {

      return res.status(404).json({
        mensaje: "No existe un usuario con ese correo",
      });

    }



    const codigo =
      Math.floor(100000 + Math.random() * 900000).toString();



    usuario.codigoRecuperacion = codigo;

    usuario.expiracionCodigo =
      Date.now() + 10 * 60 * 1000;



    await usuario.save();



    await enviarCorreo(correo, codigo);



    res.json({
      mensaje: "Código enviado al correo",
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      mensaje: "Error enviando código",
    });

  }

});



// =========================
// VERIFICAR CÓDIGO
// =========================
router.post("/verificar-codigo", async (req, res) => {

  try {

    const {
      correo,
      codigo,
    } = req.body;



    const usuario =
      await Usuario.findOne({ correo });



    if (!usuario) {

      return res.status(404).json({
        mensaje: "Usuario no encontrado",
      });

    }



    if (usuario.codigoRecuperacion !== codigo) {

      return res.status(400).json({
        mensaje: "Código incorrecto",
      });

    }



    if (usuario.expiracionCodigo < Date.now()) {

      return res.status(400).json({
        mensaje: "Código expirado",
      });

    }



    res.json({
      mensaje: "Código correcto",
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      mensaje: "Error verificando código",
    });

  }

});



// =========================
// CAMBIAR CONTRASEÑA
// =========================
router.post("/cambiar-contrasena", async (req, res) => {

  console.log("\n🔥 CAMBIAR CONTRASEÑA INICIADO");
  console.log("BODY:", req.body);

  try {

    const {
      correo,
      codigo,
      nuevaContraseña,
    } = req.body;



    const usuario =
      await Usuario.findOne({ correo });



    if (!usuario) {

      return res.status(404).json({
        mensaje: "Usuario no encontrado",
      });

    }



    if (usuario.codigoRecuperacion !== codigo) {

      return res.status(400).json({
        mensaje: "Código incorrecto",
      });

    }



    if (usuario.expiracionCodigo < Date.now()) {

      return res.status(400).json({
        mensaje: "Código expirado",
      });

    }



    const contraseñaEncriptada =
      await bcrypt.hash(nuevaContraseña, 10);



    usuario.contraseña = contraseñaEncriptada;

    usuario.codigoRecuperacion = null;

    usuario.expiracionCodigo = null;



    await usuario.save();



    return res.json({
      mensaje: "Contraseña actualizada correctamente",
    });

  } catch (error) {

    console.log("💥 ERROR BACKEND:");
    console.log(error);

    return res.status(500).json({
      mensaje: "Error cambiando contraseña",
    });

  }

});





  // =========================
// GUARDAR LINK TOKEN
// =========================

router.post("/guardar-link-token", async (req, res) => {
  try {
    const { linkToken, banco, usuarioId } = req.body;

    if (!linkToken || !banco) {
      return res.status(400).json({
        mensaje: "Faltan datos (linkToken o banco)"
      });
    }

    // =========================
    // BUSCAR USUARIO
    // =========================
    const usuario = await Usuario.findById(usuarioId);

    if (!usuario) {
      return res.status(404).json({
        mensaje: "Usuario no encontrado"
      });
    }

    // =========================
    // GUARDAR DATOS FINTOC
    // =========================
    usuario.linkToken = linkToken;
    usuario.bancoConectado = banco;
    usuario.cuentaConectada = true;

    await usuario.save();

    res.json({
      ok: true,
      mensaje: "Banco conectado correctamente ✅"
    });

  } catch (error) {
    console.log(error);

    res.status(500).json({
      ok: false,
      mensaje: "Error guardando banco"
    });
  }
});





// =========================
// CREAR LINK INTENT
// =========================
router.post("/fintoc/crear-link-intent", async (req, res) => {
  try {
    const response = await fetch("https://api.fintoc.com/v1/link_intents", {
      method: "POST",
      headers: {
        Authorization: process.env.FINTOC_SECRET_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        product: "movements",
        holder_type: "individual",
        country: "cl"
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Error Fintoc:", data);
      return res.status(500).json({ error: "Error creando link intent" });
    }

    console.log("✅ Link Intent creado:", data.id);
    res.json({ widget_token: data.widget_token });

  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

// =========================
// EXCHANGE TOKEN → LINK TOKEN
// =========================


router.post("/fintoc/exchange", async (req, res) => {
  console.log("📥 Exchange recibido:", req.body);

  const { exchangeToken, usuarioId } = req.body;

  if (!exchangeToken) {
    return res.status(400).json({ ok: false, mensaje: "Falta exchangeToken" });
  }

  if (!usuarioId) {
    return res.status(400).json({ ok: false, mensaje: "Falta usuarioId" });
  }

  try {
    console.log("🔄 Llamando a Fintoc exchange...");

    const response = await fetch(
      `https://api.fintoc.com/v1/links/exchange?exchange_token=${exchangeToken}`,
      {
        method: "GET",  // ✅ Es GET, no POST
        headers: {
          Authorization: process.env.FINTOC_SECRET_KEY
        }
      }
    );

    const linkData = await response.json();
    console.log("📦 Respuesta Fintoc:", response.status, JSON.stringify(linkData));

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        mensaje: "Error Fintoc: " + (linkData.error?.message || "desconocido")
      });
    }

    // Guardar en DB
    const usuario = await Usuario.findById(usuarioId);
    if (!usuario) {
      return res.status(404).json({ ok: false, mensaje: "Usuario no encontrado" });
    }

    // ✅ CORRECCIÓN: Guardar link_token, NO id
    usuario.linkToken = linkData.link_token;
    usuario.bancoConectado = linkData.institution?.name || "Banco";
    usuario.cuentaConectada = true;
    await usuario.save();

    console.log("✅ link_token guardado:", linkData.link_token);
    res.json({ ok: true, mensaje: "Banco conectado ✅" });

  } catch (err) {
    console.error("💥 Error exchange:", err);
    res.status(500).json({ ok: false, mensaje: "Error interno" });
  }
});

// =========================
// CUENTAS
// =========================
router.get("/cuentas", async (req, res) => {
  try {
    const { usuarioId } = req.query;
    const usuario = await Usuario.findById(usuarioId);
    if (!usuario) return res.status(404).json({ error: "Usuario no encontrado" });

    await migrarCuentasManuales(usuario);

    if (usuario.linkToken) {
      await sincronizarCuentasFintoc(usuario);
    }

    const cuentas = await Cuenta.find({ usuarioId }).sort({ tipo: 1, nombre: 1 });
    const cuentasFormateadas = await Promise.all(cuentas.map(formatearCuenta));
    const saldoTotal = cuentasFormateadas.reduce((sum, cuenta) => sum + (cuenta.saldo || 0), 0);

    res.json({
      ok: true,
      saldoTotal,
      cuentas: cuentasFormateadas,
      banco: usuario.bancoConectado
    });
  } catch (err) {
    console.error("Error cuentas:", err);
    res.status(500).json({ error: err.message || "Error interno" });
  }
});

router.post("/cuentas", async (req, res) => {
  try {
    const { usuarioId, nombre, tipoCuenta, tipo, saldoInicial, saldo } = req.body;
    if (!usuarioId || !nombre) {
      return res.status(400).json({ ok: false, error: "Faltan usuarioId o nombre" });
    }

    const usuario = await Usuario.findById(usuarioId);
    if (!usuario) return res.status(404).json({ ok: false, error: "Usuario no encontrado" });

    const cuenta = await Cuenta.create({
      usuarioId,
      nombre,
      tipo: "manual",
      tipoCuenta: tipoCuenta || tipo || "other",
      saldo: Number(saldoInicial ?? saldo ?? 0),
      saldoInicial: Number(saldoInicial ?? saldo ?? 0),
      moneda: "CLP"
    });

    res.status(201).json({ ok: true, cuenta: await formatearCuenta(cuenta) });
  } catch (err) {
    console.error("Error creando cuenta:", err);
    res.status(500).json({ ok: false, error: err.message || "Error interno" });
  }
});

router.get("/cuentas/:id", async (req, res) => {
  try {
    const { usuarioId } = req.query;
    if (!esObjectId(req.params.id)) {
      return res.status(400).json({ ok: false, error: "ID de cuenta inválido" });
    }

    const cuenta = await Cuenta.findOne({ _id: req.params.id, usuarioId });
    if (!cuenta) return res.status(404).json({ ok: false, error: "Cuenta no encontrada" });

    res.json({ ok: true, cuenta: await formatearCuenta(cuenta) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Error interno" });
  }
});

router.put("/cuentas/:id", async (req, res) => {
  try {
    const { usuarioId, nombre, tipoCuenta, saldoInicial } = req.body;
    if (!esObjectId(req.params.id)) {
      return res.status(400).json({ ok: false, error: "ID de cuenta inválido" });
    }

    const cuenta = await Cuenta.findOne({ _id: req.params.id, usuarioId, tipo: "manual" });

    if (!cuenta) return res.status(404).json({ ok: false, error: "Cuenta manual no encontrada" });

    if (nombre) cuenta.nombre = nombre;
    if (tipoCuenta) cuenta.tipoCuenta = tipoCuenta;
    if (saldoInicial !== undefined) {
      cuenta.saldoInicial = Number(saldoInicial);
      cuenta.saldo = Number(saldoInicial);
    }

    await cuenta.save();
    res.json({ ok: true, cuenta: await formatearCuenta(cuenta) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Error interno" });
  }
});

router.delete("/cuentas/:id", async (req, res) => {
  try {
    const { usuarioId } = req.body;
    if (!esObjectId(req.params.id)) {
      return res.status(400).json({ ok: false, error: "ID de cuenta inválido" });
    }

    const cuenta = await Cuenta.findOne({ _id: req.params.id, usuarioId, tipo: "manual" });

    if (!cuenta) return res.status(404).json({ ok: false, error: "Cuenta manual no encontrada" });

    const movimientos = await Movimiento.find({ cuentaId: cuenta._id, origen: "manual" });
    await eliminarCategoriasDeMovimientos(usuarioId, movimientos);
    await Movimiento.deleteMany({ cuentaId: cuenta._id, origen: "manual" });
    await Cuenta.findByIdAndDelete(cuenta._id);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Error interno" });
  }
});

router.get("/fintoc/cuentas", async (req, res) => {
  req.url = `/cuentas?usuarioId=${encodeURIComponent(req.query.usuarioId || "")}`;
  router.handle(req, res);
});

router.post("/fintoc/cuenta-manual", async (req, res) => {
  req.url = "/cuentas";
  router.handle(req, res);
});

// =========================
// MOVIMIENTOS
// =========================
router.get("/movimientos", async (req, res) => {
  try {
    const { usuarioId } = req.query;
    if (!usuarioId) return res.status(400).json({ error: "Falta usuarioId" });

    const movimientos = await obtenerMovimientosFiltrados(req.query);
    const normalizados = movimientos.map((mov) => normalizarMovimiento(mov, mov.cuentaId));
    const balance = await obtenerBalanceTotalCuentas(usuarioId);
    res.json({ movimientos: normalizados, resumen: construirResumen(movimientos, balance) });
  } catch (err) {
    console.error("Error movimientos:", err);
    res.status(500).json({ error: err.message || "Error interno" });
  }
});

router.get("/movimientos/:id", async (req, res) => {
  try {
    const { usuarioId } = req.query;
    const filtro = { usuarioId };

    if (esObjectId(req.params.id)) {
      filtro._id = req.params.id;
    } else {
      filtro.movimientoExternoId = req.params.id;
    }

    const movimiento = await Movimiento.findOne(filtro).populate("cuentaId");
    if (!movimiento) {
      return res.status(404).json({ ok: false, error: "Movimiento no encontrado" });
    }

    res.json({ ok: true, movimiento: normalizarMovimiento(movimiento, movimiento.cuentaId) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Error interno" });
  }
});

router.post("/movimientos", async (req, res) => {
  try {
    const { usuarioId, cuentaId, monto, descripcion, categoriaId, fecha } = req.body;
    if (!usuarioId || !cuentaId || monto === undefined || !descripcion) {
      return res.status(400).json({
        ok: false,
        error: "Faltan usuarioId, cuentaId, monto o descripcion"
      });
    }

    if (!Number.isFinite(Number(monto))) {
      return res.status(400).json({ ok: false, error: "Monto inválido" });
    }

    const cuenta = await Cuenta.findOne({ _id: cuentaId, usuarioId });

    if (!cuenta) return res.status(404).json({ ok: false, error: "Cuenta no encontrada" });

    const movimiento = await Movimiento.create({
      usuarioId,
      cuentaId,
      monto: Number(monto),
      descripcion,
      categoriaId: categoriaId || null,
      fecha: fecha ? new Date(fecha) : new Date(),
      origen: "manual",
      movimientoExternoId: null
    });

    if (categoriaId) {
      await Categoria.findOneAndUpdate(
        { usuarioId, movimientoId: movimiento._id.toString() },
        { usuarioId, movimientoId: movimiento._id.toString(), categoria: categoriaId },
        { upsert: true }
      );
    }

    res.status(201).json({ ok: true, movimiento: normalizarMovimiento(movimiento, cuenta) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Error interno" });
  }
});

router.put("/movimientos/:id", async (req, res) => {
  try {
    const { usuarioId, cuentaId, monto, descripcion, categoriaId, fecha } = req.body;
    if (!esObjectId(req.params.id)) {
      return res.status(400).json({ ok: false, error: "Solo se pueden editar movimientos manuales internos" });
    }

    const movimiento = await Movimiento.findOne({ _id: req.params.id, usuarioId, origen: "manual" });

    if (!movimiento) {
      return res.status(404).json({ ok: false, error: "Movimiento manual no encontrado" });
    }

    if (cuentaId) {
      const cuenta = await Cuenta.findOne({ _id: cuentaId, usuarioId });
      if (!cuenta) return res.status(404).json({ ok: false, error: "Cuenta no encontrada" });
      movimiento.cuentaId = cuentaId;
    }
    if (monto !== undefined) {
      if (!Number.isFinite(Number(monto))) {
        return res.status(400).json({ ok: false, error: "Monto inválido" });
      }
      movimiento.monto = Number(monto);
    }
    if (descripcion) movimiento.descripcion = descripcion;
    if (categoriaId !== undefined) movimiento.categoriaId = categoriaId || null;
    if (fecha) movimiento.fecha = new Date(fecha);

    await movimiento.save();
    if (categoriaId) {
      await Categoria.findOneAndUpdate(
        { usuarioId, movimientoId: movimiento._id.toString() },
        {
          usuarioId,
          movimientoId: movimiento._id.toString(),
          categoria: categoriaId,
          categoriaPersonalizada: null
        },
        { upsert: true }
      );
    } else {
      await Categoria.deleteOne({ usuarioId, movimientoId: movimiento._id.toString() });
    }

    res.json({ ok: true, movimiento: normalizarMovimiento(movimiento) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Error interno" });
  }
});

router.delete("/movimientos/:id", async (req, res) => {
  try {
    const { usuarioId } = req.body;
    if (!esObjectId(req.params.id)) {
      return res.status(400).json({ ok: false, error: "Solo se pueden eliminar movimientos manuales internos" });
    }

    const movimiento = await Movimiento.findOneAndDelete({
      _id: req.params.id,
      usuarioId,
      origen: "manual"
    });

    if (!movimiento) {
      return res.status(404).json({ ok: false, error: "Movimiento manual no encontrado" });
    }

    await Categoria.deleteOne({ usuarioId, movimientoId: movimiento._id.toString() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Error interno" });
  }
});

router.get("/fintoc/movimientos", async (req, res) => {
  try {
    const { usuarioId } = req.query;
    const usuario = await Usuario.findById(usuarioId);
    if (!usuario) return res.status(404).json({ error: "Usuario no encontrado" });

    if (usuario.linkToken) {
      await sincronizarMovimientosFintoc(usuario);
    }

    const movimientos = await obtenerMovimientosFiltrados(req.query);
    const balance = await obtenerBalanceTotalCuentas(usuarioId);

    res.json({
      movimientos: movimientos.map((mov) => normalizarMovimiento(mov, mov.cuentaId)),
      resumen: construirResumen(movimientos, balance)
    });
  } catch (err) {
    console.error("Error movimientos:", err);
    res.status(500).json({ error: err.message || "Error interno" });
  }
});

router.post("/fintoc/sincronizar", async (req, res) => {
  try {
    const { usuarioId } = req.body;
    const usuario = await Usuario.findById(usuarioId);

    if (!usuario || !usuario.linkToken) {
      return res.status(404).json({ ok: false, error: "Sin banco conectado" });
    }

    const resultado = await sincronizarMovimientosFintoc(usuario);
    res.json({ ok: true, ...resultado });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Error interno" });
  }
});

router.get("/perfil-financiero", async (req, res) => {
  try {
    const { usuarioId } = req.query;
    const movimientos = await Movimiento.find({ usuarioId }).populate("cuentaId");
    const gastos = movimientos.filter((m) => m.monto < 0);

    const porMes = {};
    const porCategoria = {};
    const porCuenta = {};
    const porOrigen = { manual: 0, banco: 0, combinado: 0 };

    gastos.forEach((mov) => {
      const total = Math.abs(mov.monto);
      const mes = mov.fecha.toISOString().slice(0, 7);
      const categoria = mov.categoriaId || "sin_categoria";
      const cuenta = mov.cuentaId?.nombre || "Sin cuenta";

      porMes[mes] = (porMes[mes] || 0) + total;
      porCategoria[categoria] = (porCategoria[categoria] || 0) + total;
      porCuenta[cuenta] = (porCuenta[cuenta] || 0) + total;
      porOrigen[mov.origen] = (porOrigen[mov.origen] || 0) + total;
      porOrigen.combinado += total;
    });

    res.json({
      ok: true,
      totalGastadoPorMes: porMes,
      totalGastadoPorCategoria: porCategoria,
      totalGastadoPorCuenta: porCuenta,
      gastosManuales: porOrigen.manual,
      gastosBanco: porOrigen.banco,
      gastosCombinados: porOrigen.combinado
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Error interno" });
  }
});

// =========================
// USUARIOS / PRESUPUESTO
// =========================
router.put("/usuarios/presupuesto", verificarToken, async (req, res) => {
  try {
    const { usuarioId, presupuestoMensual } = req.body;

    if (!usuarioId || presupuestoMensual === undefined) {
      return res.status(400).json({
        ok: false,
        error: "Faltan usuarioId o presupuestoMensual"
      });
    }

    const presupuesto = Number(presupuestoMensual);
    if (!Number.isFinite(presupuesto) || presupuesto < 0) {
      return res.status(400).json({
        ok: false,
        error: "El presupuesto mensual debe ser un número mayor o igual a 0"
      });
    }

    const usuario = await Usuario.findById(usuarioId);
    if (!usuario) return res.status(404).json({ ok: false, error: "Usuario no encontrado" });

    usuario.presupuestoMensual = presupuesto;
    await usuario.save();

    const presupuestoEstado = await calcularEstadoPresupuesto(usuario);
    res.json({ ok: true, presupuestoMensual: presupuesto, ...presupuestoEstado });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Error interno" });
  }
});

// =========================
// ESTADÍSTICAS
// =========================
router.get("/estadisticas/resumen", async (req, res) => {
  try {
    const { usuarioId } = req.query;
    const usuario = await Usuario.findById(usuarioId);
    if (!usuario) return res.status(404).json({ ok: false, error: "Usuario no encontrado" });

    const { inicio, fin } = obtenerRangoMes();
    const movimientos = await Movimiento.find({
      usuarioId,
      fecha: { $gte: inicio, $lt: fin }
    });
    const totales = sumarMovimientos(movimientos, await obtenerBalanceTotalCuentas(usuarioId));
    const presupuesto = await calcularEstadoPresupuesto(usuario);

    res.json({
      ok: true,
      ...totales,
      presupuesto: presupuesto.presupuesto,
      porcentajeUtilizado: presupuesto.porcentajeUtilizado,
      alertas: presupuesto.alertas
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Error interno" });
  }
});

router.get("/estadisticas/categorias", async (req, res) => {
  try {
    const { usuarioId } = req.query;
    const { inicio, fin } = obtenerRangoMes();
    const mapaCategorias = await obtenerMapaCategorias(usuarioId);
    const movimientos = soloGastos(await Movimiento.find({
      usuarioId,
      fecha: { $gte: inicio, $lt: fin }
    }));

    const gastosPorCategoria = {};
    movimientos.forEach((mov) => {
      const categoria = obtenerCategoriaMovimiento(mov, mapaCategorias);
      gastosPorCategoria[categoria] = (gastosPorCategoria[categoria] || 0) + Math.abs(mov.monto);
    });

    res.json({ ok: true, gastosPorCategoria });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Error interno" });
  }
});

router.get("/estadisticas/cuentas", async (req, res) => {
  try {
    const { usuarioId } = req.query;
    const { inicio, fin } = obtenerRangoMes();
    const movimientos = soloGastos(await Movimiento.find({
      usuarioId,
      fecha: { $gte: inicio, $lt: fin }
    }).populate("cuentaId"));

    const gastosPorCuenta = {};
    movimientos.forEach((mov) => {
      const cuenta = mov.cuentaId?.nombre || "Sin cuenta";
      gastosPorCuenta[cuenta] = (gastosPorCuenta[cuenta] || 0) + Math.abs(mov.monto);
    });

    res.json({ ok: true, gastosPorCuenta });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Error interno" });
  }
});

router.get("/estadisticas/presupuesto", async (req, res) => {
  try {
    const { usuarioId } = req.query;
    const usuario = await Usuario.findById(usuarioId);
    if (!usuario) return res.status(404).json({ ok: false, error: "Usuario no encontrado" });

    const estado = await calcularEstadoPresupuesto(usuario);
    res.json({
      ok: true,
      presupuesto: estado.presupuesto,
      gastoMensual: estado.gastoMensual,
      restante: estado.presupuesto - estado.gastoMensual,
      porcentajeUtilizado: estado.porcentajeUtilizado,
      alertas: estado.alertas
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Error interno" });
  }
});

router.post("/fintoc/desconectar", async (req, res) => {
  try {
    const { usuarioId } = req.body;
    const uid = objectId(usuarioId);

    const usuario = await Usuario.findById(uid);
    if (!usuario) {
      return res.status(404).json({ error: "Sin banco conectado" });
    }

    // ─── PRIMERO: invalidar el token ──────────────────────────────────────────
    // Esto se hace ANTES de cualquier borrado para cortar la race condition:
    // si el frontend tiene una llamada concurrente a /fintoc/movimientos,
    // ese endpoint revisa usuario.linkToken para decidir si sincroniza con
    // Fintoc. Si el token ya está vacío, no sincroniza y no recrea movimientos
    // justo después de que los borremos.
    usuario.linkToken = "";
    usuario.bancoConectado = "";
    usuario.cuentaConectada = false;
    await usuario.save();

    // ─── LOG 1: cuentas bancarias encontradas ─────────────────────────────────
    const cuentasBancarias = await Cuenta.find({ usuarioId: uid, tipo: "bancaria" }).select("_id");
    const cuentaIds = cuentasBancarias.map((c) => c._id);
    console.log(`[desconectar] cuentas bancarias encontradas: ${cuentaIds.length}`, cuentaIds.map(String));

    let totalMovimientosEliminados = 0;
    let totalCategoriasEliminadas = 0;

    // ─── CASCADE: cuenta por cuenta ──────────────────────────────────────────
    for (const cuentaId of cuentaIds) {
      const movsDeCuenta = await Movimiento.find({ usuarioId: uid, cuentaId }).select("_id movimientoExternoId");
      console.log(`  cuenta ${cuentaId}: ${movsDeCuenta.length} movimientos`);

      const cats = await eliminarCategoriasDeMovimientos(uid, movsDeCuenta);
      totalCategoriasEliminadas += cats;

      const resMov = await Movimiento.deleteMany({ usuarioId: uid, cuentaId });
      totalMovimientosEliminados += resMov.deletedCount || 0;
    }

    // ─── Eliminar cuentas bancarias ───────────────────────────────────────────
    const cuentasEliminadas = await Cuenta.deleteMany({ usuarioId: uid, tipo: "bancaria" });
    console.log(`[desconectar] movimientos eliminados (cascade): ${totalMovimientosEliminados}`);
    console.log(`[desconectar] cuentas eliminadas: ${cuentasEliminadas.deletedCount}`);

    // ─── RED DE SEGURIDAD 1: origen === "banco" que hayan escapado ────────────
    const sobrantesBanco = await Movimiento.deleteMany({ usuarioId: uid, origen: "banco" });
    console.log(`[desconectar] sobrantes origen=banco: ${sobrantesBanco.deletedCount}`);
    totalMovimientosEliminados += sobrantesBanco.deletedCount || 0;

    // ─── RED DE SEGURIDAD 2: movimientos huérfanos ────────────────────────────
    const cuentasRestantes = await Cuenta.find({ usuarioId: uid }).select("_id");
    const idsValidos = cuentasRestantes.map((c) => c._id);
    const huerfanos = await Movimiento.deleteMany({
      usuarioId: uid,
      cuentaId: { $nin: idsValidos }
    });
    console.log(`[desconectar] huérfanos eliminados: ${huerfanos.deletedCount}`);
    totalMovimientosEliminados += huerfanos.deletedCount || 0;

    // ─── LOG 3: estado final ──────────────────────────────────────────────────
    const restantes = await Movimiento.find({ usuarioId: uid });
    console.log(`[desconectar] movimientos restantes en DB: ${restantes.length}`);
    if (restantes.length) {
      console.log("[desconectar] ATENCIÓN – sobrevivieron:",
        restantes.map((m) => ({ _id: m._id, cuentaId: m.cuentaId, origen: m.origen }))
      );
    }

    // ─── BARRIDO TARDÍO AUTOMÁTICO ─────────────────────────────────────────────
    // Red de seguridad final: si pese a las revalidaciones de token alguna
    // sincronización ya estaba a mitad de un fetch a Fintoc y termina de
    // insertar datos DESPUÉS de que respondemos aquí, este barrido (corre solo,
    // 4s después, sin que el frontend tenga que hacer nada) los vuelve a borrar.
    setTimeout(async () => {
      try {
        const sobrantesTardios = await Movimiento.deleteMany({ usuarioId: uid, origen: "banco" });
        const cuentasVivas = await Cuenta.find({ usuarioId: uid }).select("_id");
        const idsVivos = cuentasVivas.map((c) => c._id);
        const huerfanosTardios = await Movimiento.deleteMany({ usuarioId: uid, cuentaId: { $nin: idsVivos } });
        if (sobrantesTardios.deletedCount || huerfanosTardios.deletedCount) {
          console.log(`[desconectar] barrido tardío atrapó remanentes -> origen=banco: ${sobrantesTardios.deletedCount}, huérfanos: ${huerfanosTardios.deletedCount}`);
        }
      } catch (e) {
        console.error("[desconectar] error en barrido tardío:", e);
      }
    }, 4000);

    res.json({
      ok: true,
      mensaje: "Banco desconectado y datos bancarios eliminados",
      eliminados: {
        cuentas: cuentasEliminadas.deletedCount || 0,
        movimientos: totalMovimientosEliminados,
        categorias: totalCategoriasEliminadas
      }
    });
  } catch (err) {
    console.error("[desconectar] Error:", err);
    res.status(500).json({ error: "Error interno" });
  }
});


// ✅ DELETE eliminar categoría personalizada + limpiar movimientos
router.delete("/fintoc/categorias-personalizadas/:id", async (req, res) => {
  try {
    const cat = await CategoriaPersonalizada.findById(req.params.id);
    if (!cat) return res.status(404).json({ ok: false, error: "No encontrada" });

    // Limpiar todos los movimientos que usaban esta categoría
    await Categoria.updateMany(
      { usuarioId: cat.usuarioId, categoria: "otro", categoriaPersonalizada: cat.nombre },
      { $set: { categoria: "sin_categoria", categoriaPersonalizada: null } }
    );

    await CategoriaPersonalizada.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ✅ PUT editar nombre de categoría personalizada + actualizar movimientos
router.put("/fintoc/categorias-personalizadas/:id", async (req, res) => {
  try {
    const { nuevoNombre } = req.body;
    if (!nuevoNombre || !nuevoNombre.trim()) {
      return res.status(400).json({ ok: false, error: "Nombre vacío" });
    }

    const cat = await CategoriaPersonalizada.findById(req.params.id);
    if (!cat) return res.status(404).json({ ok: false, error: "No encontrada" });

    const nombreAnterior = cat.nombre;
    const nombreNuevo = nuevoNombre.trim().toLowerCase();

    // Actualizar todos los movimientos que usaban el nombre anterior
    await Categoria.updateMany(
      { usuarioId: cat.usuarioId, categoria: "otro", categoriaPersonalizada: nombreAnterior },
      { $set: { categoriaPersonalizada: nombreNuevo } }
    );

    // Actualizar el nombre de la categoría
    cat.nombre = nombreNuevo;
    await cat.save();

    res.json({ ok: true, categoria: cat });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


///CATEGORIZA 
///CATEGORIZA 

// GET categorías de movimientos
router.get("/fintoc/categorias", async (req, res) => {
  const { usuarioId } = req.query;
  const categorias = await Categoria.find({ usuarioId });
  res.json({ categorias });
});

// POST categorizar (crear o actualizar)
router.post("/fintoc/categorizar", async (req, res) => {
  try {
    const { usuarioId, movimientoId, categoria, categoriaPersonalizada } = req.body;

    // Solo guardar si es "otro" Y tiene texto real
    if (categoria === "otro" && categoriaPersonalizada && categoriaPersonalizada.trim() !== "") {
      const nombreNormalizado = categoriaPersonalizada.trim().toLowerCase();

      await CategoriaPersonalizada.findOneAndUpdate(
        { usuarioId, nombre: nombreNormalizado },
        { usuarioId, nombre: nombreNormalizado },
        { upsert: true }
      );
    }

    // Guardar categoría del movimiento
    await Categoria.findOneAndUpdate(
      { usuarioId, movimientoId },
      {
        usuarioId,
        movimientoId,
        categoria,
        categoriaPersonalizada: (categoria === "otro" && categoriaPersonalizada && categoriaPersonalizada.trim() !== "")
          ? categoriaPersonalizada.trim().toLowerCase()
          : null
      },
      { upsert: true, new: true }
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("Error categorizando:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ✅ GET categorías personalizadas del usuario
router.get("/fintoc/categorias-personalizadas", async (req, res) => {
  try {
    const { usuarioId } = req.query;
    const cats = await CategoriaPersonalizada.find({ usuarioId }).sort({ nombre: 1 });
    res.json({ ok: true, categorias: cats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ✅ DELETE eliminar categoría personalizada
router.delete("/fintoc/categorias-personalizadas/:id", async (req, res) => {
  try {
    await CategoriaPersonalizada.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
