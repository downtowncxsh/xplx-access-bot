const winston = require("winston");
const path = require("path");

const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.File({
      filename: path.join(__dirname, "logs", "activity.log"),
    }),
    new winston.transports.Console(),
  ],
});

module.exports = logger;
