# Asignar comercial por propiedad (intranet → Leo chatbot)

Implementar en **webBazanAbril** + **public_html**.  
El bot **whatsapp-chatbot** leerá nombre y teléfono vía **scrape** de la ficha pública (fase 2 en Node, cuando la web esté en producción).

---

## Objetivo

- En la intranet, al editar una propiedad, elegir **qué usuario comercial** la gestiona (desplegable desde tabla `usuarios`).
- El **teléfono** sale del perfil del usuario (no hardcodear Miguel/David/José/Álvaro en el bot).
- Si mañana das de alta un **nuevo comercial** en usuarios, aparece en el select y el bot lo usa tras el scrape **sin redeploy de Node**.
- El visitante de la web **no ve** el comercial en la ficha (solo meta invisible en HTML).

---

## Contrato web ↔ bot

En cada ficha `https://www.inmobiliariabazan.com/propiedad?propiedad=REF`, dentro de `<head>`:

```html
<meta name="bazan:agent-name" content="David">
<meta name="bazan:agent-phone" content="34692682946">
<meta name="bazan:agent-user-id" content="12">
```

- `agent-phone`: solo dígitos, prefijo país `34` + 9 dígitos (sin `+`, espacios ni guiones).
- `agent-user-id`: PK de `usuarios.id` (trazabilidad).
- Si no hay comercial asignado: omitir metas o usar usuario **default** (Miguel o el que defináis).

---

## Paso 1 — Base de datos

### 1.1 Tabla usuarios (comprobar / ampliar)

Debe existir (nombres pueden variar; adaptar):

| Campo | Uso |
|-------|-----|
| `id` | PK |
| `nombre` (+ apellidos si aplica) | Nombre para Leo y avisos |
| `telefono_movil` o `telefono` | WhatsApp del comercial |
| `activo` | 1 = puede aparecer en select |
| `es_comercial` o `rol` | Filtrar quién es asignable a propiedades |

**Normalizar teléfono al guardar usuario** (PHP):

```php
function normalizarTelefonoWhatsapp(?string $raw): string {
    $d = preg_replace('/\D+/', '', (string) $raw);
    if ($d === '') return '';
    if (strlen($d) === 9 && in_array($d[0], ['6','7','8','9'], true)) {
        $d = '34' . $d;
    }
    return $d;
}
```

### 1.2 Tabla propiedades

```sql
ALTER TABLE propiedades
  ADD COLUMN id_usuario_comercial INT NULL,
  ADD INDEX idx_prop_comercial (id_usuario_comercial);

-- Opcional FK si la tabla usuarios existe y es InnoDB:
-- ALTER TABLE propiedades
--   ADD CONSTRAINT fk_prop_comercial
--   FOREIGN KEY (id_usuario_comercial) REFERENCES usuarios(id)
--   ON DELETE SET NULL;
```

### 1.3 Migración inicial (refs → usuario correcto)

No migrar slugs `david|jose`. Buscar el `id` de cada comercial en `usuarios` por nombre/teléfono y ejecutar:

```sql
-- Ejemplo: sustituir @id_david, @id_jose, @id_alvaro, @id_miguel por IDs reales
UPDATE propiedades SET id_usuario_comercial = @id_david WHERE referencia IN (
  '1726','1716','1713','1708','1690','1689','1688','1687','1677','1671',
  '1668','1666','1648','1641','1647','1619','1600'
);
UPDATE propiedades SET id_usuario_comercial = @id_jose WHERE referencia IN ('1678','1709','1720');
UPDATE propiedades SET id_usuario_comercial = @id_alvaro WHERE referencia IN ('1612','1702','1704','1718');
-- Resto: NULL o @id_miguel (default)
```

Ajustar nombre de columna `referencia` si en vuestro esquema es distinto.

---

## Paso 2 — `propiedades_form.php` (intranet)

### Cargar comerciales

```php
$comerciales = /* SELECT id, nombre, telefono_movil
                 FROM usuarios
                 WHERE activo = 1 AND es_comercial = 1
                 ORDER BY nombre */;
$idComercialActual = (int)($propiedad['id_usuario_comercial'] ?? 0);
```

### Select en el formulario

```php
<label for="id_usuario_comercial">Comercial / agente (Leo chatbot)</label>
<select name="id_usuario_comercial" id="id_usuario_comercial" required>
  <?php foreach ($comerciales as $u):
    $tel = normalizarTelefonoWhatsapp($u['telefono_movil'] ?? '');
  ?>
    <option value="<?= (int)$u['id'] ?>"
      <?= $idComercialActual === (int)$u['id'] ? 'selected' : '' ?>>
      <?= htmlspecialchars($u['nombre']) ?>
      <?= $tel ? ' — ' . htmlspecialchars('+' . $tel) : ' (sin teléfono)' ?>
    </option>
  <?php endforeach; ?>
</select>
<p class="help">Este comercial recibirá los leads de WhatsApp/Leo para esta propiedad.</p>
```

### Guardar (INSERT/UPDATE)

- Validar que `id_usuario_comercial` existe en `usuarios` y es comercial activo.
- Rechazar guardado si el usuario no tiene teléfono normalizado (opcional pero recomendado).
- Persistir `id_usuario_comercial` en la fila de `propiedades`.

---

## Paso 3 — `propiedad.php` (public_html)

Al cargar la propiedad, **JOIN** con usuarios:

```php
// Ejemplo conceptual
// SELECT p.*, u.id AS agent_id, u.nombre AS agent_nombre, u.telefono_movil
// FROM propiedades p
// LEFT JOIN usuarios u ON u.id = p.id_usuario_comercial AND u.activo = 1
// WHERE p.referencia = ?

function metaAgenteComercial(?array $usuario): ?array {
    if (!$usuario || empty($usuario['id'])) {
        return null; // o cargar usuario default Miguel
    }
    $tel = normalizarTelefonoWhatsapp($usuario['telefono_movil'] ?? '');
    if ($tel === '') return null;
    return [
        'id' => (int) $usuario['id'],
        'name' => trim((string) $usuario['nombre']),
        'phone' => $tel,
    ];
}

$agent = metaAgenteComercial($usuarioComercial);
// Si null, resolver usuario default (Miguel) desde BD
```

Dentro de `<head>` (invisible al visitante):

```php
<?php if ($agent): ?>
<meta name="bazan:agent-name" content="<?= htmlspecialchars($agent['name'], ENT_QUOTES, 'UTF-8') ?>">
<meta name="bazan:agent-phone" content="<?= htmlspecialchars($agent['phone'], ENT_QUOTES, 'UTF-8') ?>">
<meta name="bazan:agent-user-id" content="<?= (int) $agent['id'] ?>">
<?php endif; ?>
```

**No** mostrar nombre/teléfono en el cuerpo visible de la ficha (salvo que ya lo queráis por diseño).

---

## Paso 4 — Pruebas antes de avisar al bot

```bash
# Sustituir REF por 1726, 1720, etc.
curl -sL "https://www.inmobiliariabazan.com/propiedad?propiedad=REF" | grep -E 'bazan:agent-(name|phone|user-id)'
```

Comprobar:

- [ ] Meta con nombre y teléfono correctos tras guardar en intranet.
- [ ] Cambiar comercial en formulario → meta cambia en la ficha pública.
- [ ] Nuevo usuario comercial con móvil → aparece en select y se puede asignar.
- [ ] Usuario sin teléfono → no permitir asignar o aviso en admin.

---

## Paso 5 — whatsapp-chatbot (NO hacer en PHP; otro ticket)

Cuando los metas estén en **producción**, avisar para:

1. Añadir en SQLite `properties`: `agent_name`, `agent_phone`, `agent_user_id`.
2. Scraper `propertyPage.ts` lee los 3 meta.
3. `pickAgent(ref)`: si hay `agent_phone` en BD → notificar ahí; si no, fallback listas actuales.
4. `npm run scrape` en VPS (cron) para sincronizar.
5. Eliminar poco a poco `DAVID_REFS` / teléfonos hardcodeados.

Hasta entonces, refs nuevas se siguen añadiendo manualmente en el bot.

---

## Checklist entrega webBazanAbril

- [ ] Usuarios comerciales con `telefono_movil` normalizado
- [ ] Columna `propiedades.id_usuario_comercial`
- [ ] Migración refs existentes → IDs de usuario
- [ ] Select dinámico en `propiedades_form.php`
- [ ] Meta invisible en `propiedad.php`
- [ ] Prueba curl en 2–3 refs
- [ ] Avisar a whatsapp-chatbot para fase scrape

---

## Mapa de teléfonos actuales del bot (referencia migración)

| Persona | Teléfono WhatsApp (digits) |
|---------|----------------------------|
| Álvaro Bazán | 34646424563 |
| Miguel | 34620555989 |
| David | 34692682946 |
| José | 34663057430 |

Usar para localizar filas en `usuarios` al migrar.
