const mongoose = require("mongoose");

const usuarioSchema = new mongoose.Schema({
  nombre: {
    type: String,
    required: true,
  },
  correo: {
    type: String,
    required: true,
    unique: true,
  },
  contraseña: {
    type: String,
    required: true,
  },
  rol: {
    type: String,
    enum: ["usuario", "admin"],
    default: "usuario",
  },

  // FINTOC
  linkToken: {
    type: String,
    default: "",
  },
  bancoConectado: {
    type: String,
    default: "",
  },
  cuentaConectada: {
    type: Boolean,
    default: false,
  },
  presupuestoMensual: {
    type: Number,
    default: 0,
  },
  cuentasManuales: [{
    nombre: String,
    tipo: String,
    saldo: Number,
    moneda: { type: String, default: "CLP" },
    creadaEn: Date
  }],

  // RECUPERACIÓN
  codigoRecuperacion: {
    type: String,
    default: null,
  },
  expiracionCodigo: {
    type: Date,
    default: null,
  },

  // FECHA
  fechaCreacion: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Usuario", usuarioSchema);
