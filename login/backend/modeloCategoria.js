const mongoose = require("mongoose");

const categoriaSchema = new mongoose.Schema({
  usuarioId: { type: String, required: true },
  movimientoId: { type: String, required: true },
  categoria: { type: String, required: true },
  categoriaPersonalizada: { type: String, default: null }
});

categoriaSchema.index({ usuarioId: 1, movimientoId: 1 }, { unique: true });

module.exports = mongoose.model("Categoria", categoriaSchema);