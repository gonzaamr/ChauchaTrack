const nodemailer = require("nodemailer");

require("dotenv").config();



const transporter =
  nodemailer.createTransport({

    service: "gmail",

    auth: {

      user: process.env.EMAIL_USER,

      pass: process.env.EMAIL_PASS,

    },



    tls: {

      rejectUnauthorized: false,

    },

  });





const enviarCorreo =
  async (correo, codigo) => {

    console.log(
      "Iniciando envío correo..."
    );



    const info =
      await transporter.sendMail({

        from:
          process.env.EMAIL_USER,

        to: correo,

        subject:
          "Código de recuperación",



        html: `

          <h2>Recuperación de contraseña</h2>

          <p>Tu código es:</p>

          <h1>${codigo}</h1>

          <p>
            El código expira en 10 minutos.
          </p>

        `,

      });



    console.log(
      "Correo enviado:"
    );

    console.log(info);

  };



module.exports = enviarCorreo;