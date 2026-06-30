const mongoose = require("mongoose");

const categoriaPersonalizadaSchema = new mongoose.Schema({
  usuarioId: { type: String, required: true },
  nombre: { type: String, required: true }
});

categoriaPersonalizadaSchema.index({ usuarioId: 1, nombre: 1 }, { unique: true });

module.exports = mongoose.model("CategoriaPersonalizada", categoriaPersonalizadaSchema);