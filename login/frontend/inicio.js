const API = "/api";
const token = localStorage.getItem("token");
const usuarioId = localStorage.getItem("usuarioId");
let nombreLocal = localStorage.getItem("nombre");
let correoLocal = localStorage.getItem("correo");
let graficoFinanzas = null;
let cuentasGlobal = [];
let redirigiendoPorSesion = false;

// ========== AUTENTICACIÓN ==========

function limpiarDatosAutenticacion() {
  ["token", "nombre", "correo", "usuarioId"].forEach((clave) => {
    localStorage.removeItem(clave);
    sessionStorage.removeItem(clave);
  });
}

function cerrarSesion(sesionExpirada = false) {
  if (redirigiendoPorSesion) return;
  redirigiendoPorSesion = true;
  limpiarDatosAutenticacion();
  sessionStorage.setItem("sesionExpirada", sesionExpirada ? "1" : "");
  window.location.replace("/login.html");
}

const fetchOriginal = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await fetchOriginal(...args);
  if (!redirigiendoPorSesion && (res.status === 401 || res.status === 400)) {
    try {
      const data = await res.clone().json();
      if (res.status === 401 || data.mensaje === "Token inválido") cerrarSesion(true);
    } catch {
      if (res.status === 401) cerrarSesion(true);
    }
  }
  return res;
};

if (!token) cerrarSesion(true);

// ========== HELPERS DE TEXTO ==========

function capitalizarPrimeraLetra(valor = "") {
  return valor.replace(/^([^\p{L}]*)(\p{L})/u, (_, prefijo, letra) =>
    `${prefijo}${letra.toLocaleUpperCase("es-CL")}`
  );
}

function normalizarTextoFormulario(valor = "") {
  return capitalizarPrimeraLetra(valor.trim());
}

function configurarCapitalizacionAutomatica() {
  document.querySelectorAll("[data-autocapitalize='first']").forEach((campo) => {
    campo.addEventListener("input", () => {
      const inicio = campo.selectionStart;
      const fin = campo.selectionEnd;
      const capitalizado = capitalizarPrimeraLetra(campo.value);
      if (capitalizado !== campo.value) {
        campo.value = capitalizado;
        campo.setSelectionRange(inicio, fin);
      }
    });
  });
}

function escaparTexto(texto = "") {
  return String(texto).replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

// ========== HELPERS NUMÉRICOS ==========

function numeroSeguro(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

function obtenerIdMovimiento(movimiento) {
  return String(movimiento?._id || movimiento?.id || "");
}

function obtenerIdCuenta(cuenta) {
  return String(cuenta?._id || cuenta?.id || "");
}

function obtenerIdCuentaDesdeMovimiento(movimiento) {
  return String(
    movimiento?.cuentaId?._id ||
    movimiento?.cuentaId ||
    movimiento?.accountId ||
    movimiento?.cuenta ||
    ""
  );
}

// ========== HELPERS ID MOVIMIENTO (con fallback _id → id) ==========
// El backend MongoDB puede devolver _id o id según el serializador.
// Normalizamos siempre a string para comparaciones seguras.

function normalizarIdMov(movimiento) {
  return String(movimiento?._id || movimiento?.id || "");
}

// ========== INIT DOM ==========

document.getElementById("nombreUsuario").innerText = nombreLocal || "Usuario";
document.getElementById("perfilNombre").textContent = nombreLocal || "Usuario";
document.getElementById("perfilCorreo").textContent = correoLocal || "Sin correo";

// ========== NAVEGACIÓN ==========

function mostrarSeccion(id) {
  document.querySelectorAll(".seccion").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

// ========== PERFIL ==========

function editarPerfil() {
  const formulario = document.getElementById("perfilFormulario");
  document.getElementById("perfilNombreInput").value = nombreLocal || "";
  document.getElementById("perfilCorreoInput").value = correoLocal || "";
  formulario.style.display = formulario.style.display === "none" ? "grid" : "none";
}

async function guardarPerfil() {
  const nuevoNombre = normalizarTextoFormulario(
    document.getElementById("perfilNombreInput").value
  );
  const nuevoCorreo = document.getElementById("perfilCorreoInput").value.trim();

  if (!nuevoNombre || !nuevoCorreo) {
    return alert("Completa nombre y correo");
  }

  try {
    const res = await fetch(`${API}/usuarios/perfil`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ usuarioId, nombre: nuevoNombre, correo: nuevoCorreo })
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      return alert(data.error || "No se pudo guardar el perfil");
    }

    // Actualizar localStorage y variables locales
    nombreLocal = nuevoNombre;
    correoLocal = nuevoCorreo;
    localStorage.setItem("nombre", nuevoNombre);
    localStorage.setItem("correo", nuevoCorreo);

    // Actualizar DOM
    document.getElementById("perfilNombre").textContent = nuevoNombre;
    document.getElementById("perfilCorreo").textContent = nuevoCorreo;
    document.getElementById("nombreUsuario").innerText = nuevoNombre;

    // Ocultar formulario
    document.getElementById("perfilFormulario").style.display = "none";
    mostrarToast("✓ Perfil actualizado correctamente");
  } catch (err) {
    console.error("Error guardando perfil:", err);
    alert("No se pudo conectar con el servidor");
  }
}

// ========== CONECTAR BANCO ==========

async function conectarBanco() {
  if (!window.Fintoc) { alert("Fintoc no cargó"); return; }

  try {
    const intentRes = await fetch(`${API}/fintoc/crear-link-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token }
    });
    if (!intentRes.ok) { alert("Error creando link intent"); return; }

    const { widget_token } = await intentRes.json();

    const widget = window.Fintoc.create({
      publicKey: "pk_live_jk8Sy7TjN13gh4UgU-BRRjcuwo4t4RKc49Zpfmms-b4",
      widgetToken: widget_token,
      product: "movements",
      holderType: "individual",

      onSuccess: async (linkIntent) => {
        const exchangeToken = linkIntent.exchangeToken;
        if (!exchangeToken) { alert("Error: no se recibió exchangeToken"); return; }

        try {
          const res = await fetch(`${API}/fintoc/exchange`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: token },
            body: JSON.stringify({ exchangeToken, usuarioId })
          });
          const data = await res.json();
          if (data.ok) {
            mostrarToast("✅ Banco conectado");
            await refrescarTodoVisible();
          } else {
            alert("Error: " + (data.mensaje || "desconocido"));
          }
        } catch (err) {
          console.error("❌ Error exchange:", err);
        }
      },

      onExit: () => console.log("Usuario salió del widget"),
      onEvent: (e) => console.log("Fintoc event:", e)
    });

    widget.open();
  } catch (err) {
    console.error("ERROR FINTOC:", err);
  }
}

// ========== CACHE LOCAL ==========

let todosLosMovimientos = [];
let categoriasGuardadas = [];
let movimientosGlobal = [];
let categoriasPersonalizadas = [];

const ICONOS_CAT = {
  comida: "🍔", transporte: "🚗", ropa: "👕", higiene: "🧴",
  ocio: "🎮", salud: "💊", educacion: "📚", servicios: "💡",
  transferencia: "💸", ahorro: "🏦", otro: "📝"
};

function invalidarCacheLocal() {
  cuentasGlobal = [];
  todosLosMovimientos = [];
  movimientosGlobal = [];
  categoriasGuardadas = [];
  categoriasPersonalizadas = [];
}

// ========== CÁLCULO DE SALDOS ==========
// Las cuentas bancarias usan el balance informado por la API. Las manuales
// mantienen el saldo calculado desde sus movimientos internos.

function calcularSaldoCuenta(cuenta) {
  if (cuenta && typeof cuenta === "object") {
    if (!cuenta.manual || cuenta.tipoOrigen === "bancaria") {
      return numeroSeguro(cuenta.saldo);
    }

    cuenta = obtenerIdCuenta(cuenta);
  }

  const id = String(cuenta || "");
  return todosLosMovimientos.reduce((acc, m) => {
    if (obtenerIdCuentaDesdeMovimiento(m) !== id) return acc;
    return acc + numeroSeguro(m.amount);
  }, 0);
}

function calcularBalanceCuentas() {
  return cuentasGlobal.reduce((sum, cuenta) => sum + calcularSaldoCuenta(cuenta), 0);
}

// Saldo disponible para validar un nuevo gasto en una cuenta.
// Si se está editando un movimiento existente, se excluye ese movimiento
// del cálculo SOLO si es un gasto (negativo), para no penalizar la edición.
function calcularSaldoDisponibleCuenta(cuentaId, movimientoAExcluirId = null) {
  const id = String(cuentaId || "");
  const excluirId = movimientoAExcluirId ? String(movimientoAExcluirId) : null;

  return todosLosMovimientos.reduce((acc, m) => {
    const esElExcluido = excluirId && normalizarIdMov(m) === excluirId;

    if (esElExcluido) {
      return acc;
    }

    if (obtenerIdCuentaDesdeMovimiento(m) !== id) {
      return acc;
    }

    return acc + numeroSeguro(m.amount);
  }, 0);
}

// ========== RENDER CUENTAS ==========

function renderCuentas({ banco, cuentas } = {}) {
  // Actualizar indicador de banco solo si se pasa explícitamente
  if (banco !== undefined) {
    const bancoConectado = Boolean(banco);
    document.getElementById("estadoBanco").innerText =
      bancoConectado ? "🏦 Banco conectado ✅" : "";
    const perfilEstado = document.getElementById("perfilEstadoBanco");
    if (perfilEstado) {
      perfilEstado.innerText = bancoConectado ? "Banco conectado ✅" : "Sin banco conectado";
    }
  }

  if (!cuentas) return;

  const tipoNombre = {
    checking_account: "Cuenta Corriente",
    savings_account: "Cuenta de Ahorro",
    line_of_credit: "Línea de Crédito",
    sight_account: "Cuenta Vista",
    cash: "Efectivo",
    credit_card: "Tarjeta de Crédito",
    other: "Otra"
  };

  ["detalleCuentas", "detalleCuentasGestion"].forEach((containerId) => {
    const detalle = document.getElementById(containerId);
    if (!detalle) return;

    if (!cuentas.length) {
      detalle.innerHTML = '<p class="sin-datos">Sin cuentas disponibles</p>';
      return;
    }

    detalle.innerHTML = cuentas.map((c) => {
      const saldoCalculado = c._saldoVisual !== undefined
        ? c._saldoVisual
        : calcularSaldoCuenta(c);
      const acciones = containerId === "detalleCuentasGestion" && c.manual
        ? `<button class="btn-eliminar-cuenta" onclick="eliminarCuentaManual('${obtenerIdCuenta(c)}')">Eliminar</button>`
        : "";
      const pendiente = c._pendiente ? ' style="opacity:.55"' : "";

      return `
        <div class="cuenta-item"${pendiente}>
          <div class="cuenta-info">
            <span class="cuenta-tipo">${c.nombre}</span>
            <span class="cuenta-numero">${tipoNombre[c.tipo || c.tipoCuenta] || c.tipo || c.tipoCuenta || "Cuenta"} · ${c.manual ? "Manual" : "Bancaria"}</span>
            <span class="cuenta-numero">N° ${c.numero || "S/N"}</span>
          </div>
          <div class="cuenta-acciones">
            <span class="cuenta-saldo">$${saldoCalculado.toLocaleString("es-CL")}</span>
            ${acciones}
          </div>
        </div>
      `;
    }).join("");
  });
}

async function cargarSaldo() {
  try {
    const res = await fetch(`${API}/cuentas?usuarioId=${usuarioId}`, {
      headers: { Authorization: token }
    });
    if (!res.ok) return;
    const data = await res.json();
    cuentasGlobal = data.cuentas || [];
    renderCuentas({
      banco: data.banco,
      cuentas: cuentasGlobal
    });
  } catch (err) {
    console.error("Error saldo:", err);
  }
}

// ========== TOTALES DEL HEADER ==========
// Ingresos/gastos salen de movimientos desde la conexión. El saldo total sale
// del balance real de cuentas informado por el backend/API.

function calcularYRenderizarTotales(movimientos, balanceReal = null) {
  const totalIng = movimientos
    .filter(m => numeroSeguro(m.amount) > 0)
    .reduce((sum, m) => sum + numeroSeguro(m.amount), 0);

  const totalGas = movimientos
    .filter(m => numeroSeguro(m.amount) < 0)
    .reduce((sum, m) => sum + Math.abs(numeroSeguro(m.amount)), 0);

  const saldoTotal = Number.isFinite(Number(balanceReal))
    ? Number(balanceReal)
    : calcularBalanceCuentas();

  document.getElementById("totalIngresos").innerText =
    `$${totalIng.toLocaleString("es-CL")}`;
  document.getElementById("totalGastos").innerText =
    `$${totalGas.toLocaleString("es-CL")}`;
  document.getElementById("saldoTotal").innerText =
    `$${saldoTotal.toLocaleString("es-CL")}`;

  return { totalIng, totalGas, saldoTotal };
}

// ========== CARGAR MOVIMIENTOS ==========

async function cargarCategoriasGuardadas() {
  try {
    const res = await fetch(`${API}/fintoc/categorias?usuarioId=${usuarioId}`, {
      headers: { Authorization: token }
    });
    const data = await res.json();
    categoriasGuardadas = data.categorias || [];
  } catch (err) {
    console.error("Error cargando categorías:", err);
    categoriasGuardadas = [];
  }
}

async function cargarCategoriasPersonalizadas() {
  try {
    const res = await fetch(`${API}/fintoc/categorias-personalizadas?usuarioId=${usuarioId}`, {
      headers: { Authorization: token }
    });
    const data = await res.json();
    categoriasPersonalizadas = data.categorias || [];
  } catch (err) {
    categoriasPersonalizadas = [];
  }
}

function obtenerCategoria(movId) {
  // Buscar por string normalizado para tolerar _id vs id del backend
  const idNorm = String(movId || "");
  const cat = categoriasGuardadas.find(c => String(c.movimientoId) === idNorm);
  if (!cat) return null;
  if (cat.categoria === "otro") return cat.categoriaPersonalizada || "Otro";
  return cat.categoria;
}

function aplicarFiltrosLocales(movimientos) {
  let resultado = [...movimientos];

  const origen = document.getElementById("filtroOrigen")?.value || "todos";
  const desde = document.getElementById("filtroDesde")?.value;
  const hasta = document.getElementById("filtroHasta")?.value;
  const tipo = document.getElementById("filtroTipo")?.value || "todos";

  if (origen === "manual") {
  resultado = resultado.filter(m => m.origen === "manual");
}

if (origen === "banco") {
  resultado = resultado.filter(m => m.origen !== "manual");
}
  if (desde) {
    // Comparar solo fecha (ignorar hora) para evitar bugs de timezone
    resultado = resultado.filter(m => m.post_date?.slice(0, 10) >= desde);
  }
  if (hasta) {
    resultado = resultado.filter(m => m.post_date?.slice(0, 10) <= hasta);
  }
  if (tipo === "ingresos") resultado = resultado.filter(m => numeroSeguro(m.amount) > 0);
  if (tipo === "gastos")   resultado = resultado.filter(m => numeroSeguro(m.amount) < 0);

  return resultado;
}

async function cargarMovimientos() {
  try {
    await cargarCategoriasGuardadas();

    const res = await fetch(`${API}/fintoc/movimientos?usuarioId=${usuarioId}`, {
      headers: { Authorization: token }
    });
    const data = await res.json();

    // todosLosMovimientos = historial completo, sin filtros.
    // Es la fuente de verdad para ingresos/gastos desde la conexión.
    todosLosMovimientos = data.movimientos || [];

    if (!cuentasGlobal.length) {
      await cargarSaldo();
    }

    calcularYRenderizarTotales(todosLosMovimientos, data.resumen?.balance);

    // La lista visible sí puede filtrarse por fecha/origen/tipo.
    const movimientosFiltrados = aplicarFiltrosLocales(todosLosMovimientos);

    renderMovimientos("movimientosRecientes", todosLosMovimientos.slice(0, 5));
    renderMovimientos("listaMovimientos", movimientosFiltrados);

    renderCuentas({ cuentas: cuentasGlobal });

  } catch (err) {
    console.error("Error movimientos:", err);
  }
}

// ========== RENDER MOVIMIENTOS ==========
function formatearFechaMovimiento(fechaValor) {
  if (!fechaValor) return "Sin fecha";

  const fechaTexto = String(fechaValor);
  const fechaCorta = fechaTexto.slice(0, 10); // Sirve para "2026-07-01" y "2026-07-01T00:00:00.000Z"

  const [anio, mes, dia] = fechaCorta.split("-");

  if (!anio || !mes || !dia) return "Sin fecha";

  return `${dia}/${mes}/${anio}`;
}

function escaparAtributo(texto = "") {
  return String(texto)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, "&quot;");
}

function renderMovimientos(containerId, movimientos) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!movimientos || !movimientos.length) {
    container.innerHTML = '<p class="sin-datos">Sin movimientos</p>';
    return;
  }

  container.innerHTML = movimientos.map((m) => {
    const esGasto = numeroSeguro(m.amount) < 0;
    const fecha = formatearFechaMovimiento(m.post_date);
    const monto = Math.abs(numeroSeguro(m.amount)).toLocaleString("es-CL");

    const idParaCategoria = String(m.id || m._id || "");
    const categoria = obtenerCategoria(idParaCategoria);

    const origen = m.origen === "manual" ? "Manual" : "Banco";
    const idEdicion = escaparAtributo(m._id || m.id || "");
    const descEscapada = escaparAtributo(m.description || "");

    const accionesManual = m.origen === "manual"
      ? `<button class="btn-recategorizar" onclick="abrirModalMovimientoManual('${idEdicion}')">Editar</button>
         <button class="btn-eliminar-cat-modal" onclick="eliminarMovimientoManual('${idEdicion}')">Eliminar</button>`
      : "";

    const tipoHTML = esGasto
      ? `<span class="badge-tipo-movimiento badge-gasto">📉 Gasto</span>`
      : `<span class="badge-tipo-movimiento badge-ingreso">📈 Ingreso</span>`;

    const catHTML = esGasto
      ? (
          categoria
            ? `<span class="etiqueta-cat">${ICONOS_CAT[categoria] || "📝"} ${categoria}</span>
               <button class="btn-recategorizar" onclick="abrirModalCategorizar('${idParaCategoria}', '${descEscapada}', ${numeroSeguro(m.amount)})">Cambiar</button>`
            : `<button class="btn-categorizar" onclick="abrirModalCategorizar('${idParaCategoria}', '${descEscapada}', ${numeroSeguro(m.amount)})">Categorizar</button>`
        )
      : "";

    return `
      <div class="movimiento ${esGasto ? "gasto" : "ingreso"}">
        <div class="mov-info">
          <div class="mov-title-row">
            <span class="mov-desc">${m.description || "Sin descripción"}</span>
            ${tipoHTML}
          </div>

          <span class="mov-fecha">${fecha} · ${m.cuentaNombre || "Sin cuenta"} · ${origen}</span>

          <div class="mov-cat-area">${catHTML}${accionesManual}</div>
        </div>

        <span class="mov-monto ${esGasto ? "rojo" : "verde"}">
          ${esGasto ? "-" : "+"}$${monto}
        </span>
      </div>
    `;
  }).join("");
}

// ========== MODAL CATEGORIZAR ==========

async function abrirModalCategorizar(movId, descripcion, monto) {
  await cargarCategoriasPersonalizadas();

  document.getElementById("modalMovId").value = movId;
  document.getElementById("modalMovDescripcion").textContent = descripcion;
  document.getElementById("modalMovMonto").textContent =
    `${numeroSeguro(monto) > 0 ? "+" : "-"}$${Math.abs(numeroSeguro(monto)).toLocaleString("es-CL")}`;
  document.getElementById("inputOtroContainer").style.display = "none";

  const editZone = document.getElementById("editarCatContainer");
  if (editZone) editZone.style.display = "none";

  const gridPrincipal = document.getElementById("categoriasGrid");
  gridPrincipal.querySelectorAll(".cat-custom-dynamic").forEach(el => el.remove());

  const botonOtro = gridPrincipal.querySelector('[onclick*="mostrarInputOtro"]');
  categoriasPersonalizadas.forEach(c => {
    const btn = document.createElement("button");
    btn.className = "cat-btn cat-custom-dynamic";
    btn.textContent = `📝 ${c.nombre}`;
    btn.onclick = () => seleccionarCategoriaCustom(c._id, c.nombre);
    gridPrincipal.insertBefore(btn, botonOtro);
  });

  const contenedor = document.getElementById("categoriasPersonalizadasGrid");
  if (contenedor) contenedor.innerHTML = "";

  document.getElementById("modalCategorizar").style.display = "flex";
}

function seleccionarCategoriaCustom(catId, catNombre) {
  let editZone = document.getElementById("editarCatContainer");
  if (!editZone) {
    editZone = document.createElement("div");
    editZone.id = "editarCatContainer";
    editZone.style.cssText = "margin-top:12px;padding:10px;background:var(--bg-subtle);border-radius:8px;text-align:center;";
    document.getElementById("categoriasGrid").parentNode.appendChild(editZone);
  }

  const nombreEsc = catNombre.replace(/'/g, "\\'");
  editZone.style.display = "block";
  editZone.innerHTML = `
    <p style="margin:0 0 8px;font-size:14px;color:var(--text-primary)">Seleccionada: <strong>📝 ${catNombre}</strong></p>
    <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
      <button class="btn-confirmar-cat" onclick="seleccionarCategoria('otro','${nombreEsc}')">✅ Confirmar</button>
      <button class="btn-editar-cat" onclick="editarCategoriaPersonalizada('${catId}','${nombreEsc}')">✏️ Editar nombre</button>
      <button class="btn-eliminar-cat-modal" onclick="eliminarCategoriaPersonalizada('${catId}')">❌ Eliminar</button>
    </div>
  `;
}

async function editarCategoriaPersonalizada(catId, nombreActual) {
  const nuevoNombre = normalizarTextoFormulario(
    prompt("Nuevo nombre para la categoría:", nombreActual) || ""
  );
  if (!nuevoNombre || nuevoNombre.toLowerCase() === nombreActual.toLowerCase()) return;

  try {
    const res = await fetch(`${API}/fintoc/categorias-personalizadas/${catId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ nuevoNombre })
    });
    const data = await res.json();
    if (data.ok) {
      await cargarCategoriasGuardadas();
      renderMovimientos("movimientosRecientes", todosLosMovimientos.slice(0, 5));
      renderMovimientos("listaMovimientos", aplicarFiltrosLocales(todosLosMovimientos));
      const movId = document.getElementById("modalMovId").value;
      const desc = document.getElementById("modalMovDescripcion").textContent;
      const montoText = document.getElementById("modalMovMonto").textContent;
      const monto = parseInt(montoText.replace(/[^\d-]/g, "")) || 0;
      abrirModalCategorizar(movId, desc, monto);
    }
  } catch (err) {
    console.error("Error editando categoría:", err);
  }
}

function cerrarModal() {
  document.getElementById("modalCategorizar").style.display = "none";
}

function mostrarInputOtro() {
  document.getElementById("inputOtroContainer").style.display = "flex";
}

async function seleccionarCategoria(categoria, personalizada = null) {
  const movId = document.getElementById("modalMovId").value;
  const body = { usuarioId, movimientoId: movId, categoria };
  if (categoria === "otro" && personalizada && personalizada.trim()) {
    body.categoriaPersonalizada = normalizarTextoFormulario(personalizada);
  }

  const res = await fetch(`${API}/fintoc/categorizar`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.ok) {
    cerrarModal();
    await cargarCategoriasGuardadas();
    renderMovimientos("movimientosRecientes", todosLosMovimientos.slice(0, 5));
    renderMovimientos("listaMovimientos", aplicarFiltrosLocales(todosLosMovimientos));
  }
}

async function eliminarCategoriaPersonalizada(catId) {
  if (!confirm("¿Eliminar esta categoría? Los movimientos asociados quedarán sin categorizar.")) return;
  try {
    await fetch(`${API}/fintoc/categorias-personalizadas/${catId}`, {
      method: "DELETE",
      headers: { Authorization: token }
    });
    await cargarCategoriasGuardadas();
    renderMovimientos("movimientosRecientes", todosLosMovimientos.slice(0, 5));
    renderMovimientos("listaMovimientos", aplicarFiltrosLocales(todosLosMovimientos));
    const movId = document.getElementById("modalMovId").value;
    const desc = document.getElementById("modalMovDescripcion").textContent;
    abrirModalCategorizar(movId, desc, 0);
  } catch (err) {
    console.error("Error eliminando:", err);
  }
}

async function guardarOtro() {
  const movId = document.getElementById("modalMovId").value;
  const personalizada = normalizarTextoFormulario(
    document.getElementById("inputOtroCategoria").value
  );
  if (!personalizada) return alert("Escribe una categoría");

  const res = await fetch(`${API}/fintoc/categorizar`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ usuarioId, movimientoId: movId, categoria: "otro", categoriaPersonalizada: personalizada })
  });
  const data = await res.json();
  if (data.ok) {
    cerrarModal();
    document.getElementById("inputOtroCategoria").value = "";
    await cargarCategoriasGuardadas();
    renderMovimientos("movimientosRecientes", todosLosMovimientos.slice(0, 5));
    renderMovimientos("listaMovimientos", aplicarFiltrosLocales(todosLosMovimientos));
  }
}

// ========== SECCIÓN CATEGORÍAS ==========
// Usa el mismo endpoint que cargarMovimientos para garantizar consistencia.

async function cargarCategorias() {
  await cargarCategoriasGuardadas();

  const res = await fetch(`${API}/fintoc/movimientos?usuarioId=${usuarioId}`, {
    headers: { Authorization: token }
  });
  const data = await res.json();

  // Solo gastos, usando el mismo dataset que todosLosMovimientos
  movimientosGlobal = (data.movimientos || []).filter(
    m => numeroSeguro(m.amount) < 0
  );

  // Actualizar también todosLosMovimientos para mantener consistencia
  // (evita que Categorías muestre datos distintos a Movimientos)
  todosLosMovimientos = data.movimientos || [];

  const resumen = {};
  movimientosGlobal.forEach(mov => {
    // Normalizar id para que coincida con obtenerCategoria
    const idMov = String(mov.id || mov._id || "");
    const cat = obtenerCategoria(idMov) || "sin_categoria";
    if (!resumen[cat]) resumen[cat] = { total: 0, cantidad: 0 };
    resumen[cat].total += numeroSeguro(mov.amount);
    resumen[cat].cantidad++;
  });

  const resumenHTML = Object.keys(resumen).map(cat => {
    const icono = ICONOS_CAT[cat] || "❓";
    const total = Math.abs(resumen[cat].total);
    return `
      <div class="card" onclick="filtrarPorCategoriaDirecta('${cat}')" style="cursor:pointer">
        <h3>${icono} ${cat}</h3>
        <p>$${total.toLocaleString("es-CL")}</p>
        <small>${resumen[cat].cantidad} movimientos</small>
      </div>
    `;
  }).join("");

  document.getElementById("resumenCategorias").innerHTML = resumenHTML || '<p class="sin-datos">Sin gastos registrados</p>';
  
  calcularYRenderizarTotales(todosLosMovimientos);
renderCuentas({ cuentas: cuentasGlobal });
filtrarPorCategoria();
}

function filtrarPorCategoriaDirecta(cat) {
  document.getElementById("filtroCategoriaSelect").value = cat;
  filtrarPorCategoria();
}

function filtrarPorCategoria() {
  const filtro = document.getElementById("filtroCategoriaSelect").value;
  let filtrados = movimientosGlobal;

  if (filtro === "sin_categoria") {
    filtrados = movimientosGlobal.filter(m => !obtenerCategoria(String(m.id || m._id || "")));
  } else if (filtro !== "todas") {
    filtrados = movimientosGlobal.filter(m => obtenerCategoria(String(m.id || m._id || "")) === filtro);
  }

  if (!filtrados.length) {
    document.getElementById("listaCategorizada").innerHTML =
      '<p class="sin-datos">No hay movimientos en esta categoría</p>';
    return;
  }
  renderMovimientos("listaCategorizada", filtrados);
}

// ========== ESTADÍSTICAS ==========

function cargarEstadisticas() {
  cargarMovimientos().then(() => {
    calcularEstadisticas();
    cargarResumenPresupuesto();
  });
}

function fechaKeyLocal(fecha) {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, "0");
  const d = String(fecha.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function renderGraficoFinanzas() {
  const movs = todosLosMovimientos;
  const canvas = document.getElementById("graficoFinanzas");
  if (!canvas) return;

  const dias = parseInt(document.getElementById("filtroTiempoGrafico").value);
  const cat = document.getElementById("filtroCategoriaGrafico").value;

  const ahora = new Date();
  ahora.setHours(0, 0, 0, 0);
  const inicio = new Date(ahora);
  inicio.setDate(inicio.getDate() - dias);
  inicio.setHours(0, 0, 0, 0);

  const movimientosEnRango = movs.filter(m => {
    const fecha = new Date((m.post_date || "").slice(0, 10) + "T00:00:00");
    return fecha >= inicio && fecha <= ahora;
  });

  let filtrados = movimientosEnRango;
  if (cat !== "todos") {
    filtrados = filtrados.filter(m => obtenerCategoria(String(m.id || m._id || "")) === cat);
  }

  const porFecha = {};
  const labels = [];

  for (let fecha = new Date(inicio); fecha <= ahora; fecha.setDate(fecha.getDate() + 1)) {
    const key = fechaKeyLocal(fecha);
    labels.push(key);
    porFecha[key] = { ingresos: 0, gastos: 0, flujoTotal: 0 };
  }

  filtrados.forEach(m => {
    const fechaKey = (m.post_date || "").slice(0, 10);
    if (!porFecha[fechaKey]) return;

    const amt = numeroSeguro(m.amount);
    if (amt > 0) porFecha[fechaKey].ingresos += amt;
    if (amt < 0) porFecha[fechaKey].gastos += Math.abs(amt);
  });

  movimientosEnRango.forEach(m => {
    const fechaKey = (m.post_date || "").slice(0, 10);
    if (!porFecha[fechaKey]) return;
    porFecha[fechaKey].flujoTotal += numeroSeguro(m.amount);
  });

  const labelsDisplay = labels.map(f => {
    const [y, mo, d] = f.split("-");
    return `${d}/${mo}/${y}`;
  });

  const ingresos = labels.map(f => porFecha[f].ingresos);
  const gastos = labels.map(f => porFecha[f].gastos);

  const balanceActual = calcularBalanceCuentas();
  const flujoRango = labels.reduce((sum, f) => sum + porFecha[f].flujoTotal, 0);
  let acum = balanceActual - flujoRango;
  const balance = labels.map((f) => {
    acum += porFecha[f].flujoTotal;
    return acum;
  });

  if (graficoFinanzas) graficoFinanzas.destroy();

  const ctx = canvas.getContext("2d");
  graficoFinanzas = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labelsDisplay,
      datasets: [
        {
          type: "bar",
          label: "Ingresos", data: ingresos,
          borderColor: "#4CAF50", backgroundColor: "rgba(76,175,80,0.08)",
          borderWidth: 1, order: 2
        },
        {
          type: "bar",
          label: "Gastos", data: gastos,
          borderColor: "#E53935", backgroundColor: "rgba(229,57,53,0.08)",
          borderWidth: 1, order: 2
        },
        {
          type: "line",
          label: "Balance histórico", data: balance,
          borderColor: "#1976D2",
          borderWidth: 2, tension: 0.2, pointRadius: 1, fill: false, order: 1
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => ` ${c.dataset.label}: $${Math.round(c.parsed.y).toLocaleString("es-CL")}`
          }
        }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 10, maxRotation: 45 } },
        y: { ticks: { callback: (v) => "$" + Math.round(v).toLocaleString("es-CL") } }
      }
    }
  });
}

function limpiarEstadisticas() {
  ["cantMovimientos", "promedioGasto", "mayorGasto", "mayorGastoDesc",
   "mayorIngreso", "mayorIngresoDesc"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerText = id.includes("Desc") ? "" : id === "cantMovimientos" ? "0" : "$0";
  });
  const listaCat = document.getElementById("listaCategoriasGastos");
  if (listaCat) listaCat.innerHTML = "";
}

function calcularEstadisticas() {
  const movs = todosLosMovimientos;
  if (!movs.length) {
    limpiarEstadisticas();
    renderGraficoFinanzas();
    return;
  }

  const gastos = movs.filter(m => numeroSeguro(m.amount) < 0);
  const ingresos = movs.filter(m => numeroSeguro(m.amount) > 0);

  document.getElementById("cantMovimientos").innerText = movs.length;

  const diasUnicos = [...new Set(
    gastos.map(m => (m.post_date || "").slice(0, 10))
      .filter(Boolean)
  )].length || 1;

  const totalGastos = gastos.reduce((sum, m) => sum + Math.abs(numeroSeguro(m.amount)), 0);
  document.getElementById("promedioGasto").innerText =
    `$${Math.round(totalGastos / diasUnicos).toLocaleString("es-CL")}`;

  if (gastos.length) {
    const mayor = gastos.reduce((max, m) =>
      Math.abs(numeroSeguro(m.amount)) > Math.abs(numeroSeguro(max.amount)) ? m : max
    );
    document.getElementById("mayorGasto").innerText =
      `$${Math.abs(numeroSeguro(mayor.amount)).toLocaleString("es-CL")}`;
    document.getElementById("mayorGastoDesc").innerText = mayor.description || "";
  }

  if (ingresos.length) {
    const mayor = ingresos.reduce((max, m) =>
      numeroSeguro(m.amount) > numeroSeguro(max.amount) ? m : max
    );
    document.getElementById("mayorIngreso").innerText =
      `$${numeroSeguro(mayor.amount).toLocaleString("es-CL")}`;
    document.getElementById("mayorIngresoDesc").innerText = mayor.description || "";
  }

  // Gastos por tipo (campo type del movimiento bancario)
  const categorias = {};
  gastos.forEach(m => {
    const tipo = m.type || "otro";
    categorias[tipo] = (categorias[tipo] || 0) + Math.abs(numeroSeguro(m.amount));
  });

  const listaCat = document.getElementById("listaCategoriasGastos");
  if (listaCat) {
    listaCat.innerHTML = Object.entries(categorias)
      .sort((a, b) => b[1] - a[1])
      .map(([tipo, total]) => `
        <div class="categoria-item">
          <span>${tipo}</span>
          <span class="rojo">$${total.toLocaleString("es-CL")}</span>
        </div>
      `).join("") || '<p class="sin-datos">Sin gastos registrados</p>';
  }

  renderGraficoFinanzas();
}

// ========== PRESUPUESTO ==========

function pintarResumenPresupuesto(data = {}) {
  const presupuesto = Number(data.presupuesto ?? data.presupuestoMensual ?? 0);
  const porcentaje = Number(data.porcentajeUtilizado ?? 0);
  const alertas = data.alertas || [];

  const presupuestoEl = document.getElementById("presupuestoMensual");
  const porcentajeEl = document.getElementById("porcentajePresupuesto");
  const alertasEl = document.getElementById("alertasPresupuesto");
  const inputPerfil = document.getElementById("inputPresupuestoMensual");
  const estadoPerfil = document.getElementById("perfilPresupuestoEstado");

  if (presupuestoEl) presupuestoEl.innerText = `$${presupuesto.toLocaleString("es-CL")}`;
  if (porcentajeEl) porcentajeEl.innerText = `${porcentaje}% utilizado`;
  if (inputPerfil) inputPerfil.value = presupuesto || "";
  if (estadoPerfil) {
    estadoPerfil.innerText = presupuesto
      ? `${porcentaje}% utilizado este mes`
      : "Sin presupuesto configurado";
  }
  if (alertasEl) {
    alertasEl.innerHTML = alertas
      .map(alerta => `<p class="alerta-item warning">${alerta}</p>`)
      .join("");
  }
}

function mostrarEstadoPresupuesto(mensaje, tipo = "info") {
  const estadoPerfil = document.getElementById("perfilPresupuestoEstado");
  if (!estadoPerfil) return;
  estadoPerfil.textContent = mensaje;
  estadoPerfil.className = `estado-presupuesto ${tipo}`;
}

function setGuardandoPresupuesto(guardando) {
  const boton = document.getElementById("btnGuardarPresupuesto");
  if (!boton) return;
  boton.disabled = guardando;
  boton.textContent = guardando ? "Guardando..." : "Guardar presupuesto";
}

async function cargarResumenPresupuesto() {
  try {
    const res = await fetch(`${API}/estadisticas/resumen?usuarioId=${usuarioId}`, {
      headers: { Authorization: token }
    });
    if (!res.ok) return;
    const data = await res.json();
    pintarResumenPresupuesto(data);
    return data;
  } catch (err) {
    console.error("Error cargando presupuesto:", err);
    return null;
  }
}

async function guardarPresupuestoMensual() {
  const inputPresupuesto = document.getElementById("inputPresupuestoMensual");
  const presupuestoMensual = Number(inputPresupuesto.value);

  if (!Number.isFinite(presupuestoMensual) || presupuestoMensual < 0) {
    mostrarEstadoPresupuesto("Ingresa un presupuesto válido", "error");
    return;
  }

  setGuardandoPresupuesto(true);
  mostrarEstadoPresupuesto("Guardando presupuesto...", "info");

  try {
    const res = await fetch(`${API}/usuarios/presupuesto`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ usuarioId, presupuestoMensual })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      mostrarEstadoPresupuesto(data.error || "No se pudo guardar el presupuesto", "error");
      return;
    }

    pintarResumenPresupuesto({ ...data, presupuesto: presupuestoMensual, presupuestoMensual });
    await cargarMovimientos();
    await cargarResumenPresupuesto();
    mostrarEstadoPresupuesto("✓ Presupuesto registrado correctamente", "success");
    mostrarToast("✓ Presupuesto actualizado correctamente");
  } catch (err) {
    console.error("Error guardando presupuesto:", err);
    mostrarEstadoPresupuesto("No se pudo conectar con el servidor", "error");
  } finally {
    setGuardandoPresupuesto(false);
  }
}

// ========== DESCONECTAR BANCO ==========

async function desconectarBanco() {
  if (!confirm("¿Desconectar banco? Se eliminarán sus cuentas bancarias, movimientos bancarios y categorías asociadas.")) return;

  invalidarCacheLocal();
  renderCuentas({ banco: false, cuentas: [] });
  calcularYRenderizarTotales([]);
  renderMovimientos("movimientosRecientes", []);
  renderMovimientos("listaMovimientos", []);
  limpiarEstadisticas();
  pintarResumenPresupuesto({ presupuesto: 0, porcentajeUtilizado: 0, alertas: [] });

  const llamarDesconectar = () =>
    fetch(`${API}/fintoc/desconectar`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ usuarioId })
    }).then(r => r.json());

  try {
    await llamarDesconectar();
    const data = await llamarDesconectar();
    if (data.ok) {
      mostrarToast("✅ Banco desconectado correctamente.");
    } else {
      alert(data.error || "No se pudo desconectar el banco");
    }
  } catch (err) {
    console.error("Error:", err);
    alert("No se pudo conectar con el servidor");
  } finally {
    await refrescarTodoVisible();
  }
}

// ========== CUENTAS MANUALES ==========

async function crearMovimientoNotificacion(cuentaId, nombreCuenta, monto, descripcion) {
  // Registra un movimiento de ingreso inicial para notificar la creación
  // de una cuenta (manual o bancaria) con saldo conocido.
  const montoAbs = Math.abs(Number(monto) || 0);
  if (!cuentaId || montoAbs <= 0) return null;

  const res = await fetch(`${API}/movimientos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({
      usuarioId,
      cuentaId,
      monto: montoAbs,
      descripcion: descripcion || `Saldo inicial - ${nombreCuenta}`,
      fecha: new Date().toISOString().slice(0, 10),
      categoriaId: ""
    })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "No se pudo registrar el movimiento de notificación");
  }
  return data;
}

async function agregarCuentaManual() {
  const nombre = normalizarTextoFormulario(
    document.getElementById("nombreCuentaManual").value
  );
  const tipo = document.getElementById("tipoCuentaManual").value;
  const saldoStr = document.getElementById("saldoCuentaManual").value;
  const saldoInicial = Number(saldoStr);

  if (!nombre || saldoStr === "") return alert("Completa todos los campos");
  if (Number.isNaN(saldoInicial) || saldoInicial < 0) {
    return alert("El saldo inicial debe ser un número mayor o igual a 0");
  }

  // Mostrar cuenta optimista mientras se procesa
  const tempId = `temp-${Date.now()}`;
  const cuentaOptimista = {
    id: tempId, _id: tempId, nombre, tipo, tipoCuenta: tipo,
    numero: "Manual", moneda: "CLP", manual: true, _pendiente: true
  };
  cuentasGlobal = [...cuentasGlobal, cuentaOptimista];
  // El saldo optimista se muestra desde todosLosMovimientos (aún sin el ingreso inicial)
  // así que forzamos el saldo visualmente solo en el pendiente
  renderCuentas({
    banco: document.getElementById("estadoBanco")?.innerText.includes("conectado"),
    cuentas: cuentasGlobal.map(c =>
      c.id === tempId ? { ...c, _saldoVisual: saldoInicial } : c
    )
  });

  document.getElementById("nombreCuentaManual").value = "";
  document.getElementById("saldoCuentaManual").value = "";

  try {
    // 1. Crear cuenta con saldo 0 en el backend
    const res = await fetch(`${API}/cuentas`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ usuarioId, nombre, tipoCuenta: tipo, saldoInicial: 0 })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      // Revertir optimista
      cuentasGlobal = cuentasGlobal.filter(c => c.id !== tempId);
      renderCuentas({ cuentas: cuentasGlobal });
      return alert(data.error || "No se pudo agregar la cuenta");
    }

    // 2. Refrescar cuentas para obtener ID real de MongoDB
    await cargarSaldo();

    // 3. Buscar la cuenta recién creada en la lista actualizada
    const cuentaCreada =
      data.cuenta ||
      data.nuevaCuenta ||
      cuentasGlobal.find(c =>
        c.manual && c.nombre === nombre && (c.tipo === tipo || c.tipoCuenta === tipo)
      );

    const cuentaId = cuentaCreada?.id || cuentaCreada?._id;

    if (!cuentaId) {
      alert("Cuenta creada, pero no se pudo registrar el saldo inicial (ID no encontrado).");
      await cargarMovimientos();
      return;
    }

    // 4. Registrar ingreso inicial como movimiento (fuente de verdad del saldo)
    if (saldoInicial > 0) {
      await crearMovimientoNotificacion(cuentaId, nombre, saldoInicial, `Saldo inicial - ${nombre}`);
    }

    mostrarToast("✓ Cuenta agregada" + (saldoInicial > 0 ? " e ingreso inicial registrado" : ""));

  } catch (err) {
    console.error("Error creando cuenta:", err);
    cuentasGlobal = cuentasGlobal.filter(c => c.id !== tempId);
    alert(err.message || "No se pudo conectar con el servidor");
  } finally {
    // Siempre reconciliar con servidor para que los saldos cuadren
    await cargarSaldo();
    await cargarMovimientos();
  }
}

async function eliminarCuentaManual(cuentaId) {
  if (!confirm("¿Eliminar esta cuenta manual? También se eliminarán sus movimientos manuales.")) return;

  const cuentasAntes = [...cuentasGlobal];
  const movimientosAntes = [...todosLosMovimientos];

  // Optimista
  cuentasGlobal = cuentasGlobal.filter(c => obtenerIdCuenta(c) !== cuentaId);
  todosLosMovimientos = todosLosMovimientos.filter(
    m => obtenerIdCuentaDesdeMovimiento(m) !== cuentaId
  );
  calcularYRenderizarTotales(todosLosMovimientos);
  renderCuentas({ cuentas: cuentasGlobal });
  renderMovimientos("movimientosRecientes", todosLosMovimientos.slice(0, 5));
  renderMovimientos("listaMovimientos", aplicarFiltrosLocales(todosLosMovimientos));

  try {
    const res = await fetch(`${API}/cuentas/${cuentaId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ usuarioId })
    });
    const data = await res.json();
    if (!data.ok) {
      // Rollback
      cuentasGlobal = cuentasAntes;
      todosLosMovimientos = movimientosAntes;
      calcularYRenderizarTotales(todosLosMovimientos);
      renderCuentas({ cuentas: cuentasGlobal });
      renderMovimientos("movimientosRecientes", todosLosMovimientos.slice(0, 5));
      renderMovimientos("listaMovimientos", aplicarFiltrosLocales(todosLosMovimientos));
      return alert(data.error || "No se pudo eliminar la cuenta");
    }
    mostrarToast("✓ Cuenta manual eliminada");
  } catch (err) {
    console.error("Error eliminando cuenta manual:", err);
    cuentasGlobal = cuentasAntes;
    todosLosMovimientos = movimientosAntes;
    calcularYRenderizarTotales(todosLosMovimientos);
    renderCuentas({ cuentas: cuentasGlobal });
    renderMovimientos("movimientosRecientes", todosLosMovimientos.slice(0, 5));
    renderMovimientos("listaMovimientos", aplicarFiltrosLocales(todosLosMovimientos));
    alert("No se pudo eliminar la cuenta");
  } finally {
    await cargarSaldo();
    await cargarMovimientos();
  }
}

// ========== MOVIMIENTOS MANUALES ==========

function actualizarCategoriaSegunTipo() {
  const tipo = document.getElementById("manualTipoMovimiento")?.value || "gasto";
  const categoriaContainer = document.getElementById("manualCategoriaContainer");
  const categoriaSelect = document.getElementById("manualCategoria");
  if (!categoriaContainer || !categoriaSelect) return;
  if (tipo === "ingreso") {
    categoriaContainer.style.display = "none";
    categoriaSelect.value = "";
  } else {
    categoriaContainer.style.display = "block";
  }
}

async function abrirModalMovimientoManual(movimientoId = null) {
  await cargarSaldo();

  const modal = document.getElementById("modalMovimientoManual");
  const cuentaSelect = document.getElementById("manualCuenta");
  const cuentas = cuentasGlobal.filter(c => c.manual);

  if (!cuentas.length) {
    alert("Primero crea una cuenta manual");
    mostrarSeccion("seccionCuentas");
    return;
  }

  cuentaSelect.innerHTML = cuentas
    .map(c => `<option value="${obtenerIdCuenta(c)}">${c.nombre}</option>`)
    .join("");

  // Resetear formulario
  document.getElementById("manualMovimientoId").value = movimientoId || "";
  document.getElementById("manualTipoMovimiento").value = "gasto";
  document.getElementById("manualMonto").value = "";
  document.getElementById("manualDescripcion").value = "";
  document.getElementById("manualFecha").value = new Date().toISOString().slice(0, 10);
  document.getElementById("manualCategoria").value = "";

  if (movimientoId) {
    const mov = todosLosMovimientos.find(
      m => normalizarIdMov(m) === String(movimientoId)
    );
    if (mov) {
      const monto = numeroSeguro(mov.amount);
      const esIngreso = monto > 0;
      document.getElementById("manualCuenta").value =
        obtenerIdCuentaDesdeMovimiento(mov) || "";
      document.getElementById("manualTipoMovimiento").value = esIngreso ? "ingreso" : "gasto";
      document.getElementById("manualMonto").value = Math.abs(monto);
      document.getElementById("manualDescripcion").value = mov.description || "";
      document.getElementById("manualFecha").value =
        (mov.post_date || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
      document.getElementById("manualCategoria").value =
        esIngreso ? "" : (obtenerCategoria(String(mov.id || mov._id || "")) || "");
    }
  }

  actualizarCategoriaSegunTipo();
  modal.style.display = "flex";
}

function cerrarModalMovimientoManual() {
  document.getElementById("modalMovimientoManual").style.display = "none";
}

async function guardarMovimientoManual() {
  const movimientoId = document.getElementById("manualMovimientoId").value;
  const tipoMovimiento = document.getElementById("manualTipoMovimiento").value;
  const cuentaId = document.getElementById("manualCuenta").value;
  const montoIngresado = Math.abs(
    numeroSeguro(document.getElementById("manualMonto").value)
  );
  const descripcion = normalizarTextoFormulario(
    document.getElementById("manualDescripcion").value
  );
  const fecha = document.getElementById("manualFecha").value;
  const categoriaId = tipoMovimiento === "gasto"
    ? document.getElementById("manualCategoria").value
    : "";

  if (!cuentaId || !montoIngresado || !descripcion || !fecha) {
    return alert("Completa cuenta, tipo, monto, descripción y fecha");
  }
  if (montoIngresado <= 0) {
    return alert("El monto debe ser mayor a 0");
  }

  // Validación de saldo solo para gastos
  if (tipoMovimiento === "gasto") {
    const saldoDisponible = calcularSaldoDisponibleCuenta(
      cuentaId,
      movimientoId || null
    );

    if (montoIngresado > saldoDisponible) {
      const cuenta = cuentasGlobal.find(c => obtenerIdCuenta(c) === String(cuentaId));
      const nombreCuenta = cuenta?.nombre || "la cuenta seleccionada";
      // Mostrar saldo como $0 si es negativo (no confundir al usuario)
      const saldoMostrar = Math.max(0, saldoDisponible);
      return alert(
        `Saldo insuficiente en ${nombreCuenta}.\n\n` +
        `Saldo disponible: $${saldoMostrar.toLocaleString("es-CL")}\n` +
        `Gasto solicitado: $${montoIngresado.toLocaleString("es-CL")}`
      );
    }
  }

  const montoFinal = tipoMovimiento === "ingreso" ? montoIngresado : -montoIngresado;
  const body = { usuarioId, cuentaId, monto: montoFinal, descripcion, fecha, categoriaId };

  // Optimista
  const movimientosAntes = [...todosLosMovimientos];
  const cuenta = cuentasGlobal.find(c => obtenerIdCuenta(c) === String(cuentaId));
  const idOptimista = movimientoId || `temp-${Date.now()}`;

  const movimientoOptimista = {
    id: idOptimista, _id: idOptimista,
    cuentaId, cuentaNombre: cuenta?.nombre || "",
    amount: montoFinal,
    description: descripcion,
    post_date: fecha,
    origen: "manual",
    _pendiente: true
  };

  if (movimientoId) {
    todosLosMovimientos = todosLosMovimientos.map(m =>
      normalizarIdMov(m) === String(movimientoId) ? { ...m, ...movimientoOptimista } : m
    );
  } else {
    todosLosMovimientos = [movimientoOptimista, ...todosLosMovimientos];
  }

  calcularYRenderizarTotales(todosLosMovimientos);
  renderMovimientos("movimientosRecientes", todosLosMovimientos.slice(0, 5));
  renderMovimientos("listaMovimientos", aplicarFiltrosLocales(todosLosMovimientos));
  renderCuentas({ cuentas: cuentasGlobal });
  cerrarModalMovimientoManual();

  try {
    const res = await fetch(`${API}/movimientos${movimientoId ? `/${movimientoId}` : ""}`, {
      method: movimientoId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!data.ok) {
      todosLosMovimientos = movimientosAntes;
      calcularYRenderizarTotales(todosLosMovimientos);
      renderMovimientos("movimientosRecientes", todosLosMovimientos.slice(0, 5));
      renderMovimientos("listaMovimientos", aplicarFiltrosLocales(todosLosMovimientos));
      renderCuentas({ cuentas: cuentasGlobal });
      return alert(data.error || "No se pudo guardar el movimiento");
    }
    mostrarToast("✓ Movimiento guardado");
  } catch (err) {
    console.error("Error guardando movimiento:", err);
    todosLosMovimientos = movimientosAntes;
    calcularYRenderizarTotales(todosLosMovimientos);
    renderMovimientos("movimientosRecientes", todosLosMovimientos.slice(0, 5));
    renderMovimientos("listaMovimientos", aplicarFiltrosLocales(todosLosMovimientos));
    renderCuentas({ cuentas: cuentasGlobal });
    alert("No se pudo conectar con el servidor");
  } finally {
    await cargarMovimientos();
    await cargarSaldo();
  }
}

async function eliminarMovimientoManual(movimientoId) {
  if (!confirm("¿Eliminar este movimiento manual?")) return;

  const movimientosAntes = [...todosLosMovimientos];
  todosLosMovimientos = todosLosMovimientos.filter(
    m => normalizarIdMov(m) !== String(movimientoId)
  );
  calcularYRenderizarTotales(todosLosMovimientos);
  renderMovimientos("movimientosRecientes", todosLosMovimientos.slice(0, 5));
  renderMovimientos("listaMovimientos", aplicarFiltrosLocales(todosLosMovimientos));
  renderCuentas({ cuentas: cuentasGlobal });

  try {
    const res = await fetch(`${API}/movimientos/${movimientoId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ usuarioId })
    });
    const data = await res.json();
    if (!data.ok) {
      todosLosMovimientos = movimientosAntes;
      calcularYRenderizarTotales(todosLosMovimientos);
      renderMovimientos("movimientosRecientes", todosLosMovimientos.slice(0, 5));
      renderMovimientos("listaMovimientos", aplicarFiltrosLocales(todosLosMovimientos));
      renderCuentas({ cuentas: cuentasGlobal });
      return alert(data.error || "No se pudo eliminar el movimiento");
    }
    mostrarToast("✓ Movimiento eliminado");
  } catch (err) {
    console.error("Error eliminando movimiento:", err);
    todosLosMovimientos = movimientosAntes;
    calcularYRenderizarTotales(todosLosMovimientos);
    renderMovimientos("movimientosRecientes", todosLosMovimientos.slice(0, 5));
    renderMovimientos("listaMovimientos", aplicarFiltrosLocales(todosLosMovimientos));
    renderCuentas({ cuentas: cuentasGlobal });
    alert("No se pudo conectar con el servidor");
  } finally {
    await cargarMovimientos();
    await cargarSaldo();
  }
}

// ========== TOAST ==========

let _toastTimeout = null;
function mostrarToast(mensaje) {
  const toast = document.getElementById("toastFeedback");
  if (!toast) return;
  toast.textContent = mensaje;
  toast.classList.add("visible");
  clearTimeout(_toastTimeout);
  _toastTimeout = setTimeout(() => toast.classList.remove("visible"), 2800);
}

// ========== REFRESCO GLOBAL ==========

async function refrescarTodoVisible() {
  await cargarSaldo();
  await cargarMovimientos();
  calcularEstadisticas();
  await cargarResumenPresupuesto();
  await cargarCategorias();
}

// ========== SIDEBAR MÓVIL ==========

function toggleSidebarMovil() {
  document.getElementById("sidebar").classList.toggle("sidebar-abierto");
  document.getElementById("overlaySidebar").classList.toggle("visible");
}

function cerrarSidebarMovil() {
  document.getElementById("sidebar").classList.remove("sidebar-abierto");
  document.getElementById("overlaySidebar").classList.remove("visible");
}

// ========== INIT ==========

configurarCapitalizacionAutomatica();
if (token && usuarioId) {
  cargarSaldo();
  cargarMovimientos();
  cargarResumenPresupuesto();
}
