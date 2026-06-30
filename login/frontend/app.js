const API = "http://localhost:5000/api";

let correoTemporal = "";
let codigoVerificado = false;
let currentView = "viewLogin";

function limpiarDatosAutenticacion() {
  ["token", "nombre", "correo", "usuarioId"].forEach((clave) => {
    localStorage.removeItem(clave);
    sessionStorage.removeItem(clave);
  });
}

function limpiarFormularioLogin() {
  const form = document.getElementById("formLogin");
  if (form) form.reset();

  const mensajeLogin = document.getElementById("mensajeLogin");
  if (mensajeLogin) mensajeLogin.innerText = "";
}

function capitalizarPrimeraLetra(valor) {
  return valor.replace(/^([^\p{L}]*)(\p{L})/u, (_, prefijo, letra) =>
    `${prefijo}${letra.toLocaleUpperCase("es-CL")}`
  );
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

function cambiarVista(nueva) {
  const actual = document.getElementById(currentView);
  const siguiente = document.getElementById(nueva);

  actual.classList.remove("active");

  setTimeout(() => {
    siguiente.classList.add("active");
    currentView = nueva;
  }, 200);
}

function mostrarRegistro() {
  cambiarVista("viewRegistro");
}

function volverLogin() {
  limpiarFormularioLogin();
  cambiarVista("viewLogin");
}

function mostrarRecuperacion() {
  cambiarVista("viewRecuperacion");
}





// REGISTRO

async function registro() {
  const nombre = document.getElementById("nombreRegistro").value.trim();
  const apellido = document.getElementById("apellidoRegistro").value.trim();
  const rut = document.getElementById("rutRegistro").value;
  const telefono = document.getElementById("telefonoRegistro").value;
  const correo = document.getElementById("correoRegistro").value;
  const contraseña = document.getElementById("contraseñaRegistro").value;
  const confirmar = document.getElementById("confirmarContraseña").value;

  // VALIDACIONES PRO
  if (!nombre || !apellido || !rut || !telefono || !correo || !contraseña) {
    return alert("Completa todos los campos");
  }

  if (contraseña !== confirmar) {
    return alert("Las contraseñas no coinciden");
  }

  const res = await fetch(`${API}/registro`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nombre,
      apellido,
      rut,
      telefono,
      correo,
      contraseña
    })
  });

  const data = await res.json();

  document.getElementById("mensajeRegistro").innerText = data.mensaje;

  if (res.ok) {
    alert("Cuenta creada en ChauchaTrack 💰");
    volverLogin();
  }
}




// LOGIN
async function login() {
  const correo = document.getElementById("correoLogin").value.trim();
  const contraseña = document.getElementById("contraseñaLogin").value;
  const mensajeLogin = document.getElementById("mensajeLogin");

  const res = await fetch(`${API}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ correo, contraseña })
  });

  const data = await res.json();

  if (!res.ok || !data.token) {
    mensajeLogin.innerText = data.mensaje || "No se pudo iniciar sesión";
    return;
  }

  mensajeLogin.innerText = "";
  localStorage.setItem("token", data.token);
  localStorage.setItem("nombre", data.usuario.nombre);
  localStorage.setItem("correo", data.usuario.correo);
  localStorage.setItem("usuarioId", data.usuario.id);

  limpiarFormularioLogin();
  window.location.replace("/inicio.html");
}





// ENVIAR CÓDIGO
async function enviarCodigo() {
  const correo = document.getElementById("correoRecuperacion").value;
  correoTemporal = correo;

  const res = await fetch(`${API}/solicitar-recuperacion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ correo })
  });

  const data = await res.json();

  alert(data.mensaje);

  if (res.ok) {
    cambiarVista("viewCodigo");
  }
}





// VERIFICAR CÓDIGO
async function verificarCodigo() {
  const codigo = document.getElementById("codigoRecuperacion").value;

  const res = await fetch(`${API}/verificar-codigo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      correo: correoTemporal,
      codigo
    })
  });

  const data = await res.json();

  document.getElementById("mensajeCodigo").innerText = data.mensaje;

  if (res.ok) {
    codigoVerificado = true;
    cambiarVista("viewNuevaPass");
  }
}





// CAMBIAR CONTRASEÑA
async function cambiarContraseña() {
  if (!codigoVerificado) return alert("Verifica el código primero");

  const nuevaContraseña = document.getElementById("nuevaContraseña").value;
  const codigo = document.getElementById("codigoRecuperacion").value;

  const res = await fetch(`${API}/cambiar-contrasena`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      correo: correoTemporal,
      codigo,
      nuevaContraseña
    })
  });

  const data = await res.json();

  alert(data.mensaje);

  if (res.ok) {
    correoTemporal = "";
    codigoVerificado = false;

    cambiarVista("viewLogin");

    document.getElementById("mensajeLogin").innerText =
      "Contraseña cambiada correctamente. Inicia sesión.";
  }
}

window.addEventListener("DOMContentLoaded", () => {
  limpiarDatosAutenticacion();
  limpiarFormularioLogin();
  configurarCapitalizacionAutomatica();
});

window.addEventListener("pageshow", () => {
  limpiarDatosAutenticacion();
  limpiarFormularioLogin();
});
