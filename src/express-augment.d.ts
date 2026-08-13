import "express-serve-static-core";

declare module "express-serve-static-core" {
  interface Request {
    /** Cuerpo raw JSON (para firma Meta) si se configuró verify en express.json */
    rawBody?: Buffer;
  }
}
