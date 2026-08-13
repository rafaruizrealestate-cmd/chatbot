import "dotenv/config";
import { randomBytes } from "node:crypto";
import { getDb } from "../db/database.js";
import {
  createUser,
  deleteUser,
  findUserByName,
  listUsers,
  setUserDisabled,
  setUserPassword,
  setUserRole,
} from "./auth.js";

function usage(): void {
  console.log(`Gestión de usuarios del panel

  npm run panel:user -- list
  npm run panel:user -- create <usuario> [--role admin|viewer] [--password <clave>]
  npm run panel:user -- password <usuario> [--password <clave>]
  npm run panel:user -- role <usuario> <admin|viewer>
  npm run panel:user -- disable <usuario>
  npm run panel:user -- enable <usuario>
  npm run panel:user -- delete <usuario>

Sin --password se genera una aleatoria y se muestra una sola vez.`);
}

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function generatePassword(): string {
  return randomBytes(12).toString("base64url");
}

function requireUser(username: string): { id: number } {
  const user = findUserByName(username);
  if (!user) {
    console.error(`No existe el usuario "${username}"`);
    process.exit(1);
  }
  return user;
}

function main(): void {
  getDb();
  const args = process.argv.slice(2);
  const command = args[0];
  const target = args[1];

  switch (command) {
    case "list": {
      const users = listUsers();
      if (users.length === 0) {
        console.log("Sin usuarios. Crea uno con: npm run panel:user -- create <usuario> --role admin");
        return;
      }
      for (const u of users) {
        console.log(
          `${u.username.padEnd(20)} ${u.role.padEnd(7)} ${u.disabled ? "DESACTIVADO" : "activo"}  último acceso: ${u.last_login_at ?? "nunca"}`,
        );
      }
      return;
    }
    case "create": {
      if (!target) return usage();
      const password = flag(args, "password") ?? generatePassword();
      const roleRaw = flag(args, "role");
      const role = roleRaw === "admin" ? "admin" : "viewer";
      createUser({ username: target, password, role });
      console.log(`Usuario "${target}" creado (${role}).`);
      if (!flag(args, "password")) console.log(`Contraseña: ${password}`);
      return;
    }
    case "password": {
      if (!target) return usage();
      const user = requireUser(target);
      const password = flag(args, "password") ?? generatePassword();
      setUserPassword(user.id, password);
      console.log(`Contraseña actualizada para "${target}" (sesiones cerradas).`);
      if (!flag(args, "password")) console.log(`Nueva contraseña: ${password}`);
      return;
    }
    case "role": {
      const role = args[2];
      if (!target || (role !== "admin" && role !== "viewer")) return usage();
      setUserRole(requireUser(target).id, role);
      console.log(`"${target}" ahora es ${role}.`);
      return;
    }
    case "disable":
    case "enable": {
      if (!target) return usage();
      setUserDisabled(requireUser(target).id, command === "disable");
      console.log(`"${target}" ${command === "disable" ? "desactivado" : "activado"}.`);
      return;
    }
    case "delete": {
      if (!target) return usage();
      deleteUser(requireUser(target).id);
      console.log(`"${target}" eliminado.`);
      return;
    }
    default:
      usage();
  }
}

main();
