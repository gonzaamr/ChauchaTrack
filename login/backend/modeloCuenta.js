const mongoose = require("mongoose");

const cuentaSchema = new mongoose.Schema({
  usuarioId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Usuario",
    required: true,
    index: true
  },
  nombre: {
    type: String,
    required: true,
    trim: true
  },
  tipo: {
    type: String,
    enum: ["bancaria", "manual"],
    required: true
  },
  tipoCuenta: {
    type: String,
    default: "other"
  },
  fintocAccountId: {
    type: String,
    default: null
  },
  numero: {
    type: String,
    default: null
  },
  moneda: {
    type: String,
    default: "CLP"
  },
  saldo: {
    type: Number,
    default: 0
  },
  saldoBanco: {
    type: Number,
    default: 0
  },
  saldoInicial: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

cuentaSchema.index(
  { usuarioId: 1, fintocAccountId: 1 },
  {
    unique: true,
    partialFilterExpression: { fintocAccountId: { $type: "string" } }
  }
);

module.exports = mongoose.model("Cuenta", cuentaSchema);
