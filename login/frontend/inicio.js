const API = "/api";
const token = localStorage.getItem("token");
const usuarioId = localStorage.getItem("usuarioId");
const nombre = localStorage.getItem("nombre");
let graficoFinanzas = null;
let cuentasGlobal = [];

const correo = localStorage.getItem("correo");
let redirigiendoPorSesion = false;

function limpiarDatosAutenticacion() {
  ["token", "nombre", "correo", "usuarioId"].forEach((clave) => {
    localStorage.removeItem(clave);
    sessionStorage.removeItem(clave);
  });
}

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
      if (res.status === 401 || data.mensaje === "Token inválido") {
        cerrarSesion(true);
      }
    } catch (err) {
      if (res.status === 401) cerrarSesion(true);
    }
  }

  return res;
};

document.getElementById("perfilNombre").textContent =
  nombre || "Usuario";

document.getElementById("perfilCorreo").textContent =
  correo || "Sin correo";

function editarPerfil() {
  const formulario = document.getElementById("perfilFormulario");

  document.getElementById("perfilNombreInput").value =
    nombre || "";

  document.getElementById("perfilCorreoInput").value =
    correo || "";

  formulario.style.display =
    formulario.style.display === "none"
      ? "grid"
      : "none";
}

if (!token) cerrarSesion(true);

document.getElementById("nombreUsuario").innerText = nombre || "Usuario";

// =========================
// NAVEGACIÓN
// =========================
function mostrarSeccion(id) {
  document.querySelectorAll(".seccion").forEach((s) => {
    s.classList.remove("active");
  });
  document.getElementById(id).classList.add("active");
}

// =========================
// CONECTAR BANCO
// =========================
async function conectarBanco() {
  console.log("🔥 Fintoc init...");

  if (!window.Fintoc) {
    alert("Fintoc no cargó");
    return;
  }

  try {
    const intentRes = await fetch(`${API}/fintoc/crear-link-intent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token
      }
    });

    if (!intentRes.ok) {
      alert("Error creando link intent");
      return;
    }

    const { widget_token } = await intentRes.json();

    const widget = window.Fintoc.create({
      publicKey: "pk_live_jk8Sy7TjN13gh4UgU-BRRjcuwo4t4RKc49Zpfmms-b4",
      widgetToken: widget_token,
      product: "movements",
      holderType: "individual",

      onSuccess: async (linkIntent) => {
        console.log("✅ SUCCESS:", JSON.stringify(linkIntent));
        const exchangeToken = linkIntent.exchangeToken;

        if (!exchangeToken) {
          alert("Error: no se recibió exchangeToken");
          return;
        }

        try {
          const res = await fetch(`${API}/fintoc/exchange`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: token
            },
            body: JSON.stringify({ exchangeToken, usuarioId })
          });

          const data = await res.json();

          if (data.ok) {
            alert("✅ Banco conectado");
            cargarSaldo();
            cargarMovimientos();
          } else {
            alert("Error: " + (data.mensaje || "desconocido"));
          }
        } catch (err) {
          console.error("❌ Error exchange:", err);
        }
      },

      onExit: () => console.log("❌ Usuario salió"),
      onEvent: (e) => console.log("📡 event:", e)
    });

    widget.open();
  } catch (err) {
    console.error("ERROR FINTOC:", err);
  }
}

// =========================
// CARGAR SALDO (CORREGIDO)
// =========================
// Pinta cuentas + saldo a partir de datos ya disponibles en memoria (sin red).
// Se usa tanto tras la respuesta real del servidor como en las actualizaciones
// "optimistas" (instantáneas) cuando el usuario agrega/elimina una cuenta manual.
function renderCuentas({ saldoTotal, banco, cuentas } = {}) {
  if (saldoTotal !== undefined) {
    document.getElementById("saldoTotal").innerText =
      `$${saldoTotal.toLocaleString("es-CL")}`;

    document.getElementById("estadoBanco").innerText =
      banco ? "🏦 Banco conectado ✅" : "";

    const perfilEstado = document.getElementById("perfilEstadoBanco");
    if (perfilEstado) {
      perfilEstado.innerText = banco ? "Banco conectado ✅" : "Sin banco conectado";
    }
  }

  ["detalleCuentas", "detalleCuentasGestion"].forEach((containerId) => {
    const detalle = document.getElementById(containerId);
    if (!detalle || !cuentas) return;

    detalle.innerHTML = cuentas.map((c) => {
      const tipoNombre = {
        checking_account: "Cuenta Corriente",
        savings_account: "Cuenta de Ahorro",
        line_of_credit: "Línea de Crédito",
        sight_account: "Cuenta Vista",
        cash: "Efectivo",
        credit_card: "Tarjeta de Crédito",
        other: "Otra"
      };
      const acciones = containerId === "detalleCuentasGestion" && c.manual
        ? `<button class="btn-eliminar-cuenta" onclick="eliminarCuentaManual('${c.id}')">Eliminar</button>`
        : "";
      const pendiente = c._pendiente ? ' style="opacity:.55"' : "";

      return `
        <div class="cuenta-item"${pendiente}>
          <div class="cuenta-info">
            <span class="cuenta-tipo">${c.nombre}</span>
            <span class="cuenta-numero">${tipoNombre[c.tipo] || c.tipo} · ${c.manual ? "Manual" : "Bancaria"}</span>
            <span class="cuenta-numero">N° ${c.numero || 'S/N'}</span>
          </div>
          <div class="cuenta-acciones">
            <span class="cuenta-saldo">$${c.saldo.toLocaleString("es-CL")}</span>
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
    console.log("🏦 Cuentas:", data);

    cuentasGlobal = data.cuentas || [];
    renderCuentas(data);
  } catch (err) {
    console.log("Error saldo:", err);
  }
}



// =========================
// CARGAR MOVIMIENTOS
// =========================
let todosLosMovimientos = [];

function renderListaMovimientosYTotales(movimientos) {
  const ultimos5 = movimientos.slice(0, 5);
  renderMovimientos("movimientosRecientes", ultimos5);
  renderMovimientos("listaMovimientos", movimientos);

  const totalIng = movimientos
    .filter(m => m.amount > 0)
    .reduce((sum, m) => sum + m.amount, 0);
  const totalGas = movimientos
    .filter(m => m.amount < 0)
    .reduce((sum, m) => sum + Math.abs(m.amount), 0);

  document.getElementById("totalIngresos").innerText =
    `$${totalIng.toLocaleString("es-CL")}`;
  document.getElementById("totalGastos").innerText =
    `$${totalGas.toLocaleString("es-CL")}`;
}

async function cargarMovimientos() {
  try {
    await cargarCategoriasGuardadas();

    const params = new URLSearchParams({ usuarioId });
    const origen = document.getElementById("filtroOrigen")?.value || "todos";
    const desde = document.getElementById("filtroDesde")?.value;
    const hasta = document.getElementById("filtroHasta")?.value;
    if (origen !== "todos") params.set("origen", origen);
    if (desde) params.set("desde", desde);
    if (hasta) params.set("hasta", hasta);

    const res = await fetch(`${API}/fintoc/movimientos?${params.toString()}`, {
      headers: { Authorization: token }
    });
    const data = await res.json();
    todosLosMovimientos = filtrarPorTipoMovimiento(data.movimientos || []);

    renderListaMovimientosYTotales(todosLosMovimientos);
  } catch (err) {
    console.error("Error movimientos:", err);
  }
}

// Limpia todo lo que el frontend tiene cacheado en memoria. Se debe llamar
// siempre que se borren datos del servidor "por fuera" del flujo normal
// (p.ej. al desconectar el banco), para evitar que queden remanentes
// visuales de cuentas/movimientos que ya no existen.
function invalidarCacheLocal() {
  cuentasGlobal = [];
  todosLosMovimientos = [];
  movimientosGlobal = [];
  categoriasGuardadas = [];
}

// Refresca TODAS las vistas que dependen de cuentas/movimientos, sin
// importar en qué pestaña esté el usuario. Esto evita que, por ejemplo,
// Estadísticas o Categorías sigan mostrando datos de una cuenta que el
// usuario ya desconectó/eliminó hasta que el usuario entre manualmente
// a esa sección.
async function refrescarTodoVisible() {
  await cargarMovimientos();
  await cargarSaldo();
  calcularEstadisticas();
  await cargarResumenPresupuesto();
  // Siempre se actualizan las categorías, no solo si la sección está visible.
  // De lo contrario movimientosGlobal queda con datos viejos aunque el usuario
  // luego abra la pestaña Categorías.
  await cargarCategorias();
}

// ========== VARIABLES GLOBALES PARA CATEGORÍAS ==========

let categoriasGuardadas = [];
let movimientosGlobal = [];

const ICONOS_CAT = {
  comida: "🍔", transporte: "🚗", ropa: "👕", higiene: "🧴",
  ocio: "🎮", salud: "💊", educacion: "📚", servicios: "💡",
  transferencia: "💸", ahorro: "🏦", otro: "📝"
};
let categoriasPersonalizadas = [];

function filtrarPorTipoMovimiento(movimientos) {
  const filtroTipo = document.getElementById("filtroTipo")?.value || "todos";
  if (filtroTipo === "ingresos") return movimientos.filter((m) => m.amount > 0);
  if (filtroTipo === "gastos") return movimientos.filter((m) => m.amount < 0);
  return movimientos;
}

function escaparTexto(texto = "") {
  return String(texto).replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

// ========== CARGAR CATEGORÍAS GUARDADAS ==========

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
  const cat = categoriasGuardadas.find(c => c.movimientoId === movId);
  if (!cat) return null;
  if (cat.categoria === "otro") return cat.categoriaPersonalizada || "Otro";
  return cat.categoria;
}

// ========== RENDER MOVIMIENTOS (ACTUALIZADO CON CATEGORÍAS) ==========

function renderMovimientos(containerId, movimientos) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!movimientos.length) {
    container.innerHTML = '<p class="sin-datos">Sin movimientos</p>';
    return;
  }

  container.innerHTML = movimientos.map((m) => {
    const esGasto = m.amount < 0;
    const fecha = new Date(m.post_date).toLocaleDateString("es-CL");
    const monto = Math.abs(m.amount).toLocaleString("es-CL");
    const categoria = obtenerCategoria(m.id);
    const origen = m.origen === "manual" ? "Manual" : "Banco";
    const accionesManual = m.origen === "manual"
      ? `<button class="btn-recategorizar" onclick="abrirModalMovimientoManual('${m._id || m.id}')">Editar</button>
         <button class="btn-eliminar-cat-modal" onclick="eliminarMovimientoManual('${m._id || m.id}')">Eliminar</button>`
      : "";

    // ✅ Si tiene categoría: mostrar etiqueta + botón cambiar
    // ✅ Si NO tiene: mostrar botón categorizar
    const catHTML = categoria
      ? `<span class="etiqueta-cat">${ICONOS_CAT[categoria] || "📝"} ${categoria}</span>
         <button class="btn-recategorizar" onclick="abrirModalCategorizar('${m.id}', '${escaparTexto(m.description || '')}', ${m.amount})">Cambiar</button>`
      : `<button class="btn-categorizar" onclick="abrirModalCategorizar('${m.id}', '${escaparTexto(m.description || '')}', ${m.amount})">Categorizar</button>`;

    return `
      <div class="movimiento ${esGasto ? 'gasto' : 'ingreso'}">
        <div class="mov-info">
          <span class="mov-desc">${m.description || 'Sin descripción'}</span>
          <span class="mov-fecha">${fecha} · ${m.cuentaNombre || "Sin cuenta"} · ${origen}</span>
          <div class="mov-cat-area">${catHTML}${accionesManual}</div>
        </div>
        <span class="mov-monto ${esGasto ? 'rojo' : 'verde'}">
          ${esGasto ? '-' : '+'}$${monto}
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
    `${monto > 0 ? "+" : "-"}$${Math.abs(monto).toLocaleString("es-CL")}`;
  document.getElementById("inputOtroContainer").style.display = "none";

  // Ocultar zona de edición si existe
  const editZone = document.getElementById("editarCatContainer");
  if (editZone) editZone.style.display = "none";

  // Generar botones de categorías personalizadas DENTRO del grid principal
  const gridPrincipal = document.getElementById("categoriasGrid");
  
  // Primero eliminar las custom anteriores del grid
  gridPrincipal.querySelectorAll(".cat-custom-dynamic").forEach(el => el.remove());

  // Agregar las personalizadas al grid (antes del botón "otro")
  const botonOtro = gridPrincipal.querySelector('[onclick*="mostrarInputOtro"]');
  
  categoriasPersonalizadas.forEach(c => {
    const btn = document.createElement("button");
    btn.className = "cat-btn cat-custom-dynamic";
    btn.textContent = `📝 ${c.nombre}`;
    btn.onclick = () => seleccionarCategoriaCustom(c._id, c.nombre);
    gridPrincipal.insertBefore(btn, botonOtro);
  });

  // Limpiar la sección separada (ya no la usamos)
  const contenedor = document.getElementById("categoriasPersonalizadasGrid");
  if (contenedor) contenedor.innerHTML = "";

  document.getElementById("modalCategorizar").style.display = "flex";
}

// ========== SELECCIONAR CATEGORÍA CUSTOM (con opciones editar/eliminar) ==========

function seleccionarCategoriaCustom(catId, catNombre) {
  // Mostrar zona de confirmación con opciones
  let editZone = document.getElementById("editarCatContainer");
  
  if (!editZone) {
    // Crear la zona si no existe
    editZone = document.createElement("div");
    editZone.id = "editarCatContainer";
    editZone.style.cssText = "margin-top:12px; padding:10px; background:#f0f0f0; border-radius:8px; text-align:center;";
    document.getElementById("categoriasGrid").parentNode.appendChild(editZone);
  }

  editZone.style.display = "block";
  editZone.innerHTML = `
    <p style="margin:0 0 8px; font-size:14px;">Seleccionada: <strong>📝 ${catNombre}</strong></p>
    <div style="display:flex; gap:8px; justify-content:center; flex-wrap:wrap;">
      <button class="btn-confirmar-cat" onclick="seleccionarCategoria('otro', '${catNombre.replace(/'/g, "\\'")}')">
        ✅ Confirmar
      </button>
      <button class="btn-editar-cat" onclick="editarCategoriaPersonalizada('${catId}', '${catNombre.replace(/'/g, "\\'")}')">
        ✏️ Editar nombre
      </button>
      <button class="btn-eliminar-cat-modal" onclick="eliminarCategoriaPersonalizada('${catId}')">
        ❌ Eliminar
      </button>
    </div>
  `;
}

// ========== EDITAR CATEGORÍA PERSONALIZADA ==========

async function editarCategoriaPersonalizada(catId, nombreActual) {
  const nuevoNombre = normalizarTextoFormulario(prompt("Nuevo nombre para la categoría:", nombreActual) || "");
  if (!nuevoNombre || nuevoNombre.toLowerCase() === nombreActual.toLowerCase()) return;

  try {
    const res = await fetch(`${API}/fintoc/categorias-personalizadas/${catId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ nuevoNombre })
    });

    const data = await res.json();
    if (data.ok) {
      // Recargar todo
      await cargarCategoriasGuardadas();
      renderMovimientos("movimientosRecientes", todosLosMovimientos.slice(0, 5));
      renderMovimientos("listaMovimientos", todosLosMovimientos);

      // Reabrir modal actualizado
      const movId = document.getElementById("modalMovId").value;
      const desc = document.getElementById("modalMovDescripcion").textContent;
      const montoText = document.getElementById("modalMovMonto").textContent;
      const monto = parseInt(montoText.replace(/[^0-9-]/g, "")) || 0;
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

  // ✅ Solo enviar categoriaPersonalizada si realmente existe
  if (categoria === "otro" && personalizada && personalizada.trim() !== "") {
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
    renderMovimientos("listaMovimientos", todosLosMovimientos);
  }
}

async function eliminarCategoriaPersonalizada(catId) {
  if (!confirm("¿Eliminar esta categoría? Todos los movimientos con esta categoría quedarán sin categorizar.")) return;

  try {
    await fetch(`${API}/fintoc/categorias-personalizadas/${catId}`, {
      method: "DELETE",
      headers: { Authorization: token }
    });

    // Recargar categorías y movimientos
    await cargarCategoriasGuardadas();
    renderMovimientos("movimientosRecientes", todosLosMovimientos.slice(0, 5));
    renderMovimientos("listaMovimientos", todosLosMovimientos);

    // Reabrir modal actualizado
    const movId = document.getElementById("modalMovId").value;
    const desc = document.getElementById("modalMovDescripcion").textContent;
    abrirModalCategorizar(movId, desc, 0);
  } catch (err) {
    console.error("Error eliminando:", err);
  }
}

async function guardarOtro() {
  const movId = document.getElementById("modalMovId").value;
  const personalizada = normalizarTextoFormulario(document.getElementById("inputOtroCategoria").value);
  if (!personalizada) return alert("Escribe una categoría");

  const res = await fetch(`${API}/fintoc/categorizar`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({
      usuarioId,
      movimientoId: movId,
      categoria: "otro",
      categoriaPersonalizada: personalizada
    })
  });

  const data = await res.json();
  if (data.ok) {
    cerrarModal();
    document.getElementById("inputOtroCategoria").value = "";
    await cargarCategoriasGuardadas();
    renderMovimientos("movimientosRecientes", todosLosMovimientos.slice(0, 5));
    renderMovimientos("listaMovimientos", todosLosMovimientos);
  }
}

// ========== SECCIÓN CATEGORÍAS ==========

async function cargarCategorias() {
  await cargarCategoriasGuardadas();

  const res = await fetch(`${API}/movimientos?usuarioId=${usuarioId}`, {
    headers: { Authorization: token }
  });
  const data = await res.json();
  movimientosGlobal = data.movimientos || [];

  // Resumen
  const resumen = {};
  movimientosGlobal.forEach(mov => {
    const cat = obtenerCategoria(mov.id) || "sin_categoria";
    if (!resumen[cat]) resumen[cat] = { total: 0, cantidad: 0 };
    resumen[cat].total += mov.amount;
    resumen[cat].cantidad++;
  });

  let resumenHTML = "";
  Object.keys(resumen).forEach(cat => {
    const icono = ICONOS_CAT[cat] || "❓";
    const total = Math.abs(resumen[cat].total);
    resumenHTML += `
      <div class="card" onclick="filtrarPorCategoriaDirecta('${cat}')" style="cursor:pointer">
        <h3>${icono} ${cat}</h3>
        <p>$${total.toLocaleString("es-CL")}</p>
        <small>${resumen[cat].cantidad} movimientos</small>
      </div>
    `;
  });

  document.getElementById("resumenCategorias").innerHTML = resumenHTML;
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
    filtrados = movimientosGlobal.filter(m => !obtenerCategoria(m.id));
  } else if (filtro !== "todas") {
    filtrados = movimientosGlobal.filter(m => obtenerCategoria(m.id) === filtro);
  }

  if (filtrados.length === 0) {
    document.getElementById("listaCategorizada").innerHTML =
      '<p class="sin-datos">No hay movimientos en esta categoría</p>';
    return;
  }

  renderMovimientos("listaCategorizada", filtrados);
}








// =========================
// ESTADÍSTICAS
// =========================
function cargarEstadisticas() {
  // Importante: siempre se pide la lista de movimientos al servidor antes de
  // calcular. Antes, si ya había datos en memoria, se reutilizaban tal cual
  // (aunque vinieran de una cuenta ya desconectada/eliminada), dejando
  // "remanentes" visuales. Ahora siempre se refleja el estado real.
  cargarMovimientos().then(() => {
    calcularEstadisticas();
    cargarResumenPresupuesto();
  });
}

function renderGraficoFinanzas() {
  const movs = todosLosMovimientos;
  if (!movs.length) return;

  const dias = parseInt(document.getElementById("filtroTiempoGrafico").value);
  const cat = document.getElementById("filtroCategoriaGrafico").value;

  const ahora = new Date();
  const inicio = new Date(ahora);
  inicio.setDate(inicio.getDate() - dias);

  let filtrados = movs.filter(m => new Date(m.post_date) >= inicio);

  if (cat !== "todos") {
    filtrados = filtrados.filter(m => obtenerCategoria(m.id) === cat);
  }

  // Agrupar por fecha
  const porFecha = {};
  filtrados.forEach(m => {
    const fecha = new Date(m.post_date).toLocaleDateString("es-CL");
    if (!porFecha[fecha]) porFecha[fecha] = { ingresos: 0, gastos: 0 };
    if (m.amount > 0) porFecha[fecha].ingresos += m.amount;
    else porFecha[fecha].gastos += Math.abs(m.amount);
  });

  const labels = Object.keys(porFecha).sort((a, b) =>
    new Date(a.split("/").reverse().join("-")) - new Date(b.split("/").reverse().join("-"))
  );
  const ingresos = labels.map(f => porFecha[f].ingresos);
  const gastos = labels.map(f => porFecha[f].gastos);
  let acum = 0;
  const balance = labels.map((f, i) => {
    acum += ingresos[i] - gastos[i];
    return acum;
  });

  if (graficoFinanzas) graficoFinanzas.destroy();

  const ctx = document.getElementById("graficoFinanzas").getContext("2d");
  graficoFinanzas = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Ingresos", data: ingresos,
          borderColor: "#4CAF50", backgroundColor: "rgba(76,175,80,0.08)",
          borderWidth: 2, tension: 0.35, pointRadius: 3, fill: false
        },
        {
          label: "Gastos", data: gastos,
          borderColor: "#E53935", backgroundColor: "rgba(229,57,53,0.08)",
          borderWidth: 2, tension: 0.35, pointRadius: 3, fill: false
        },
        {
          label: "Balance", data: balance,
          borderColor: "#1976D2", borderDash: [6, 3],
          borderWidth: 2, tension: 0.35, pointRadius: 2, fill: false
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
  const setTexto = (id, txt) => {
    const el = document.getElementById(id);
    if (el) el.innerText = txt;
  };
  setTexto("cantMovimientos", "0");
  setTexto("promedioGasto", "$0");
  setTexto("mayorGasto", "$0");
  setTexto("mayorGastoDesc", "");
  setTexto("mayorIngreso", "$0");
  setTexto("mayorIngresoDesc", "");
  const listaCat = document.getElementById("listaCategoriasGastos");
  if (listaCat) listaCat.innerHTML = "";
}

function calcularEstadisticas() {
  const movs = todosLosMovimientos;

  // Antes se retornaba sin hacer nada cuando no había movimientos, dejando
  // los valores anteriores en pantalla (remanentes). Ahora se limpia
  // explícitamente para reflejar el estado real (sin datos bancarios).
  if (!movs.length) {
    limpiarEstadisticas();
    return;
  }

  const gastos = movs.filter((m) => m.amount < 0);
  const ingresos = movs.filter((m) => m.amount > 0);

  document.getElementById("cantMovimientos").innerText = movs.length;

  const diasUnicos = [...new Set(gastos.map((m) =>
    new Date(m.post_date).toLocaleDateString()
  ))].length || 1;

  const totalGastos = gastos.reduce((sum, m) => sum + Math.abs(m.amount), 0);
  document.getElementById("promedioGasto").innerText =
    `$${Math.round(totalGastos / diasUnicos).toLocaleString("es-CL")}`;

  if (gastos.length) {
    const mayor = gastos.reduce((max, m) =>
      Math.abs(m.amount) > Math.abs(max.amount) ? m : max
    );
    document.getElementById("mayorGasto").innerText =
      `$${Math.abs(mayor.amount).toLocaleString("es-CL")}`;
    document.getElementById("mayorGastoDesc").innerText = mayor.description || "";
  }

  if (ingresos.length) {
    const mayor = ingresos.reduce((max, m) =>
      m.amount > max.amount ? m : max
    );
    document.getElementById("mayorIngreso").innerText =
      `$${mayor.amount.toLocaleString("es-CL")}`;
    document.getElementById("mayorIngresoDesc").innerText = mayor.description || "";
  }

  const categorias = {};
  gastos.forEach((m) => {
    const tipo = m.type || "otro";
    categorias[tipo] = (categorias[tipo] || 0) + Math.abs(m.amount);
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
      `).join("");
  }
  renderGraficoFinanzas();
}


async function desconectarBanco() {
  if (!confirm("¿Desconectar banco? Se eliminarán sus cuentas bancarias, movimientos bancarios y categorías asociadas.")) return;

  // --- Limpieza optimista INMEDIATA (antes de esperar al servidor) ---
  // Así el usuario ve $0 y sin movimientos al instante, sin esperar
  // la respuesta de red. Si el servidor falla se muestra un error.
  invalidarCacheLocal();
  renderCuentas({ saldoTotal: 0, banco: "", cuentas: [] });
  renderListaMovimientosYTotales([]);
  limpiarEstadisticas();
  pintarResumenPresupuesto({ presupuesto: 0, porcentajeUtilizado: 0, alertas: [] });

  const llamarDesconectar = () =>
    fetch(`${API}/fintoc/desconectar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token
      },
      body: JSON.stringify({ usuarioId })
    }).then((res) => res.json());

  try {
    // Solución provisoria: se llama al endpoint DOS VECES en secuencia.
    // La primera puede correr en paralelo con una sincronización de Fintoc
    // ya en vuelo (race condition aún no resuelta de raíz en el backend),
    // dejando remanentes recreados justo después del borrado. La segunda
    // llamada, que arranca recién cuando la primera ya terminó del todo,
    // limpia lo que haya quedado. Esto replica manualmente lo que pasaba
    // al apretar el botón dos veces.
    let data = await llamarDesconectar();
    data = await llamarDesconectar();

    if (data.ok) {
      mostrarToast("✅ Banco desconectado correctamente.");
      // Reconciliación con el servidor para confirmar que todo quedó limpio.
      await refrescarTodoVisible();
    } else {
      alert(data.error || "No se pudo desconectar el banco");
      // Si falló, recargar desde el servidor para restaurar estado real.
      await refrescarTodoVisible();
    }
  } catch (err) {
    console.error("Error:", err);
    alert("No se pudo conectar con el servidor");
    await refrescarTodoVisible();
  }
}

async function agregarCuentaManual() {
  const nombre = normalizarTextoFormulario(document.getElementById("nombreCuentaManual").value);
  const tipo = document.getElementById("tipoCuentaManual").value;
  const saldo = document.getElementById("saldoCuentaManual").value;

  if (!nombre || !saldo) return alert("Completa todos los campos");

  // --- Actualización optimista: se muestra la cuenta de inmediato ---
  const tempId = `temp-${Date.now()}`;
  const cuentaOptimista = {
    id: tempId,
    _id: tempId,
    nombre,
    tipo,
    tipoCuenta: tipo,
    numero: "Manual",
    saldo: Number(saldo) || 0,
    moneda: "CLP",
    manual: true,
    _pendiente: true
  };

  cuentasGlobal = [...cuentasGlobal, cuentaOptimista];
  const saldoTotalOptimista = cuentasGlobal.reduce((sum, c) => sum + (c.saldo || 0), 0);
  renderCuentas({
    saldoTotal: saldoTotalOptimista,
    banco: document.getElementById("estadoBanco")?.innerText.includes("conectado"),
    cuentas: cuentasGlobal
  });

  document.getElementById("nombreCuentaManual").value = "";
  document.getElementById("saldoCuentaManual").value = "";

  try {
    const res = await fetch(`${API}/cuentas`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ usuarioId, nombre, tipoCuenta: tipo, saldoInicial: saldo })
    });

    const data = await res.json();
    if (data.ok) {
      mostrarToast("✓ Cuenta agregada");
    } else {
      alert(data.error || "No se pudo agregar la cuenta");
    }
  } catch (err) {
    console.error("Error creando cuenta:", err);
    alert("No se pudo conectar con el servidor");
  } finally {
    // Se reconcilia con el estado real del servidor (consistencia final),
    // reemplazando la cuenta temporal por los datos definitivos.
    await cargarSaldo();
  }
}

async function eliminarCuentaManual(cuentaId) {
  if (!confirm("¿Eliminar esta cuenta manual? También se eliminarán sus movimientos manuales.")) return;

  // --- Actualización optimista: se quita de la vista al instante ---
  const cuentasAntes = cuentasGlobal;
  const movimientosAntes = todosLosMovimientos;

  cuentasGlobal = cuentasGlobal.filter((c) => c.id !== cuentaId);
  todosLosMovimientos = todosLosMovimientos.filter(
    (m) => (m.cuentaId?._id || m.cuentaId) !== cuentaId
  );

  renderCuentas({
    saldoTotal: cuentasGlobal.reduce((sum, c) => sum + (c.saldo || 0), 0),
    cuentas: cuentasGlobal
  });
  renderListaMovimientosYTotales(todosLosMovimientos);

  try {
    const res = await fetch(`${API}/cuentas/${cuentaId}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: token
      },
      body: JSON.stringify({ usuarioId })
    });

    const data = await res.json();
    if (!data.ok) {
      // Rollback si el servidor rechaza la operación
      cuentasGlobal = cuentasAntes;
      todosLosMovimientos = movimientosAntes;
      renderCuentas({ cuentas: cuentasGlobal });
      renderListaMovimientosYTotales(todosLosMovimientos);
      alert(data.error || "No se pudo eliminar la cuenta");
      return;
    }

    mostrarToast("✓ Cuenta manual eliminada");
  } catch (err) {
    console.error("Error eliminando cuenta manual:", err);
    cuentasGlobal = cuentasAntes;
    todosLosMovimientos = movimientosAntes;
    renderCuentas({ cuentas: cuentasGlobal });
    renderListaMovimientosYTotales(todosLosMovimientos);
    alert("No se pudo eliminar la cuenta");
  } finally {
    await cargarSaldo();
    await cargarMovimientos();
  }
}

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
      .map((alerta) => `<p class="alerta-item warning">${alerta}</p>`)
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

function mostrarToast(mensaje) {
  const toast = document.getElementById("toastFeedback");
  if (!toast) return;

  toast.textContent = mensaje;
  toast.classList.add("visible");

  clearTimeout(mostrarToast.timeoutId);
  mostrarToast.timeoutId = setTimeout(() => {
    toast.classList.remove("visible");
  }, 2800);
}

async function refrescarDatosFinancieros() {
  await cargarMovimientos();
  await cargarSaldo();
  calcularEstadisticas();
  await cargarResumenPresupuesto();
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

    const resumenGuardado = {
      ...data,
      presupuesto: presupuestoMensual,
      presupuestoMensual
    };

    pintarResumenPresupuesto(resumenGuardado);
    await refrescarDatosFinancieros();
    pintarResumenPresupuesto(resumenGuardado);
    mostrarEstadoPresupuesto("✓ Presupuesto registrado correctamente", "success");
    mostrarToast("✓ Presupuesto actualizado correctamente");
  } catch (err) {
    console.error("Error guardando presupuesto:", err);
    mostrarEstadoPresupuesto("No se pudo conectar con el servidor", "error");
  } finally {
    setGuardandoPresupuesto(false);
  }
}

async function abrirModalMovimientoManual(movimientoId = null) {
  await cargarSaldo();

  const modal = document.getElementById("modalMovimientoManual");
  const cuentaSelect = document.getElementById("manualCuenta");
  const cuentas = cuentasGlobal.filter((c) => c.manual);

  if (!cuentas.length) {
    alert("Primero crea una cuenta manual");
    mostrarSeccion("seccionCuentas");
    return;
  }

  cuentaSelect.innerHTML = cuentas
    .map((c) => `<option value="${c.id}">${c.nombre}</option>`)
    .join("");

  document.getElementById("manualMovimientoId").value = movimientoId || "";
  document.getElementById("manualMonto").value = "";
  document.getElementById("manualDescripcion").value = "";
  document.getElementById("manualFecha").value = new Date().toISOString().slice(0, 10);
  document.getElementById("manualCategoria").value = "";

  if (movimientoId) {
    const mov = todosLosMovimientos.find((m) => (m._id || m.id) === movimientoId);
    if (mov) {
      document.getElementById("manualCuenta").value = mov.cuentaId?._id || mov.cuentaId || "";
      document.getElementById("manualMonto").value = mov.amount;
      document.getElementById("manualDescripcion").value = mov.description || "";
      document.getElementById("manualFecha").value = new Date(mov.post_date).toISOString().slice(0, 10);
      document.getElementById("manualCategoria").value = obtenerCategoria(mov.id) || "";
    }
  }

  modal.style.display = "flex";
}

function cerrarModalMovimientoManual() {
  document.getElementById("modalMovimientoManual").style.display = "none";
}

async function guardarMovimientoManual() {
  const movimientoId = document.getElementById("manualMovimientoId").value;
  const body = {
    usuarioId,
    cuentaId: document.getElementById("manualCuenta").value,
    monto: Number(document.getElementById("manualMonto").value),
    descripcion: normalizarTextoFormulario(document.getElementById("manualDescripcion").value),
    fecha: document.getElementById("manualFecha").value,
    categoriaId: document.getElementById("manualCategoria").value
  };

  if (!body.cuentaId || !body.monto || !body.descripcion || !body.fecha) {
    alert("Completa cuenta, monto, descripción y fecha");
    return;
  }

  // --- Actualización optimista ---
  const movimientosAntes = todosLosMovimientos;
  const cuenta = cuentasGlobal.find((c) => c.id === body.cuentaId);
  const idOptimista = movimientoId || `temp-${Date.now()}`;
  const movimientoOptimista = {
    id: idOptimista,
    _id: idOptimista,
    cuentaId: body.cuentaId,
    cuentaNombre: cuenta?.nombre || "",
    amount: body.monto,
    description: body.descripcion,
    post_date: body.fecha,
    origen: "manual",
    _pendiente: true
  };

  if (movimientoId) {
    todosLosMovimientos = todosLosMovimientos.map((m) =>
      (m._id || m.id) === movimientoId ? { ...m, ...movimientoOptimista } : m
    );
  } else {
    todosLosMovimientos = [movimientoOptimista, ...todosLosMovimientos];
  }
  renderListaMovimientosYTotales(todosLosMovimientos);
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
      renderListaMovimientosYTotales(todosLosMovimientos);
      alert(data.error || "No se pudo guardar el movimiento");
      return;
    }

    mostrarToast("✓ Movimiento guardado");
  } catch (err) {
    console.error("Error guardando movimiento:", err);
    todosLosMovimientos = movimientosAntes;
    renderListaMovimientosYTotales(todosLosMovimientos);
    alert("No se pudo conectar con el servidor");
  } finally {
    // Reconciliación con el servidor (consistencia final).
    await cargarMovimientos();
    await cargarSaldo();
  }
}

async function eliminarMovimientoManual(movimientoId) {
  if (!confirm("¿Eliminar este movimiento manual?")) return;

  // --- Actualización optimista ---
  const movimientosAntes = todosLosMovimientos;
  todosLosMovimientos = todosLosMovimientos.filter((m) => (m._id || m.id) !== movimientoId);
  renderListaMovimientosYTotales(todosLosMovimientos);

  try {
    const res = await fetch(`${API}/movimientos/${movimientoId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ usuarioId })
    });

    const data = await res.json();
    if (!data.ok) {
      todosLosMovimientos = movimientosAntes;
      renderListaMovimientosYTotales(todosLosMovimientos);
      alert(data.error || "No se pudo eliminar el movimiento");
      return;
    }

    mostrarToast("✓ Movimiento eliminado");
  } catch (err) {
    console.error("Error eliminando movimiento:", err);
    todosLosMovimientos = movimientosAntes;
    renderListaMovimientosYTotales(todosLosMovimientos);
    alert("No se pudo conectar con el servidor");
  } finally {
    await cargarMovimientos();
    await cargarSaldo();
  }
}
// =========================
// SIDEBAR MÓVIL
// =========================
function toggleSidebarMovil() {
  document.getElementById("sidebar").classList.toggle("sidebar-abierto");
  document.getElementById("overlaySidebar").classList.toggle("visible");
}

function cerrarSidebarMovil() {
  document.getElementById("sidebar").classList.remove("sidebar-abierto");
  document.getElementById("overlaySidebar").classList.remove("visible");
}

// =========================
// INIT
// =========================
configurarCapitalizacionAutomatica();
if (token && usuarioId) {
  cargarSaldo();
  cargarMovimientos();
  cargarResumenPresupuesto();
}
