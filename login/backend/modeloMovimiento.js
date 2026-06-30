const mongoose = require("mongoose");

const movimientoSchema = new mongoose.Schema({
  usuarioId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Usuario",
    required: true,
    index: true
  },
  cuentaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Cuenta",
    required: true,
    index: true
  },
  monto: {
    type: Number,
    required: true
  },
  descripcion: {
    type: String,
    required: true,
    trim: true
  },
  categoriaId: {
    type: String,
    default: null
  },
  fecha: {
    type: Date,
    required: true,
    index: true
  },
  origen: {
    type: String,
    enum: ["banco", "manual"],
    required: true,
    index: true
  },
  movimientoExternoId: {
    type: String,
    default: null
  },
  tipoBanco: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

movimientoSchema.index(
  { usuarioId: 1, movimientoExternoId: 1 },
  {
    unique: true,
    partialFilterExpression: { movimientoExternoId: { $type: "string" } }
  }
);

module.exports = mongoose.model("Movimiento", movimientoSchema);
