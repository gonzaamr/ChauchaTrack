const Movimiento = require("./modeloMovimiento");

function obtenerRangoMes(fecha = new Date()) {
  const inicio = new Date(fecha.getFullYear(), fecha.getMonth(), 1);
  const fin = new Date(fecha.getFullYear(), fecha.getMonth() + 1, 1);

  return { inicio, fin };
}

async function calcularGastoMensual(usuarioId, fecha = new Date()) {
  const { inicio, fin } = obtenerRangoMes(fecha);

  const resultado = await Movimiento.aggregate([
    {
      $match: {
        usuarioId,
        monto: { $lt: 0 },
        fecha: { $gte: inicio, $lt: fin }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: { $abs: "$monto" } }
      }
    }
  ]);

  return resultado[0]?.total || 0;
}

async function calcularEstadoPresupuesto(usuario, fecha = new Date()) {
  const presupuesto = Number(usuario.presupuestoMensual || 0);
  const gastoMensual = await calcularGastoMensual(usuario._id, fecha);
  const porcentajeUtilizado = presupuesto > 0
    ? Math.round((gastoMensual / presupuesto) * 100)
    : 0;

  const alertas = [];
  if (presupuesto > 0 && porcentajeUtilizado >= 100) {
    alertas.push("Has superado tu presupuesto mensual.");
  } else if (presupuesto > 0 && porcentajeUtilizado >= 75) {
    alertas.push("Has utilizado más del 75% de tu presupuesto mensual.");
  }

  return {
    presupuesto,
    gastoMensual,
    porcentajeUtilizado,
    alertas
  };
}

module.exports = {
  obtenerRangoMes,
  calcularGastoMensual,
  calcularEstadoPresupuesto
};
