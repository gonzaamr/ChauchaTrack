const jwt = require("jsonwebtoken");

require("dotenv").config();

const verificarToken = (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).json({
      mensaje: "Acceso denegado",
    });
  }

  try {
    const verificado = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    req.usuario = verificado;

    next();
  } catch (error) {
    res.status(400).json({
      mensaje: "Token inválido",
    });
  }
};

module.exports = verificarToken;