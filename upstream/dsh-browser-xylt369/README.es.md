# dsh-browser

[English](README.en.md) | [中文](README.md) | **Español** | [Français](README.fr.md) | [Русский](README.ru.md) | [العربية](README.ar.md)

Capacidades de navegación web para [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): navegación, instantáneas de accesibilidad, clics y relleno de formularios, pestañas múltiples, capturas de pantalla y adjuntos de imagen listos para modelos de visión.

Versiones de host compatibles: **dsh `0.1.0-rc.7` / `0.1.1-rc.2`**. Utiliza de forma predeterminada **Microsoft Edge** local (perfil persistente + evasión ligera de detección de automatización) y es compatible con el DNS fake-ip de Clash/Surge.

Versiones publicadas:

| Paquete | Versión |
|---|---|
| `@yeesy369/dsh-browser` | `0.6.0` |
| `@yeesy369/dsh-browser-playwright` | `0.8.1` |
| `@yeesy369/dsh-tool-browser` | `0.7.0` |
| `@yeesy369/dsh-web-permission` | `0.6.1` |

Repositorio y notas de lanzamiento: https://github.com/xylt369/dsh-browser/releases/tag/v0.8.1

---

## Instalación

1. Asegúrese de tener instalado `dsh` (`dsh --version`). Si no está instalado, ejecute `npm i -g @deepseek-ai/dsh`.
2. Instale los complementos:

```sh
dsh plugin --profile web add \
  @yeesy369/dsh-browser-playwright@0.8.1 \
  @yeesy369/dsh-tool-browser@0.7.0 \
  @yeesy369/dsh-web-permission@0.6.1
```

3. Reinicie `dsh web`.
4. Solicite al agente que abra una página web en la conversación. Si un sitio requiere inicio de sesión, inicie sesión una vez en la ventana emergente de Edge (el estado se conserva en `~/.dsh/edge-profile`).

Para actualizar una instalación existente, use el comando `plugin add` con los números de versión indicados arriba y reinicie `dsh web`.

---

## Interfaz de configuración (0.8.x)

El acceso a la configuración se encuentra en **dsh Web → Configuración → Configuración de complementos**. Tras la instalación y el reinicio, aparecerán dos tarjetas oficiales de complementos en esta página (la ruta principal ya no requiere editar YAML manualmente).

### Puerta de permisos web

Controla qué hosts pueden ser accedidos por las herramientas de navegación y extracción. Los cambios surten efecto **inmediatamente** al guardar (actualización en caliente).

| Control | Descripción |
|---|---|
| Hosts permitidos | Un nombre de host por línea; si coincide, se permite el acceso |
| Hosts denegados | Un nombre de host por línea; tiene prioridad sobre la lista de permitidos (por defecto incluye `localhost`, `metadata.google.internal`) |
| Nombres de herramientas controladas | Lista de herramientas cuyos parámetros `url` se inspeccionan (ej. `browser_navigate`, `browser_fill`, `web_fetch`) |
| Acción predeterminada para hosts no listados | `Permitir` o `Preguntar` |
| Guardar en lista de permitidos tras aprobación | Tras una aprobación en modo `Preguntar`, añade el host automáticamente a la lista de permitidos |

La parte inferior de la tarjeta ofrece **Descartar** / **Guardar**; los campos modificados pueden **Restablecer los valores predeterminados**.

### Ventana del navegador

Controla el modo de inicio de Playwright y la compatibilidad de red. Los cambios surten efecto tras **reiniciar dsh** o en el **próximo inicio del navegador**.

| Control | Descripción |
|---|---|
| Modo de ventana | `Ventana visible` / `Ventana oculta` / `Headless (Sin interfaz)` |
| Parche ligero de anti-detección | Activado por defecto (elimina huellas comunes de automatización) |
| Permitir DNS fake-ip de proxy | Activado por defecto; permite resoluciones `198.18.0.0/15` de Clash/Surge |

| Modo de ventana | Casos de uso adecuados | Consideraciones |
|---|---|---|
| Ventana visible | Inicio de sesión manual, captchas, vista previa en tiempo real | Ocupa una ventana en el escritorio |
| Ventana oculta | Navegador real sin interferir en el escritorio | No se puede ver la ventana directamente; requiere sesión de escritorio |
| Headless | Servidores / CI | Sitios con control estricto pueden detectarlo; no permite login manual |

El paquete opcional `@yeesy369/dsh-browser-settings` proporciona un panel en la barra lateral. Para la configuración diaria, se recomienda usar las tarjetas de complementos mencionadas arriba.

---

## Capacidades disponibles para el modelo

| Capacidad | Herramienta / Comportamiento |
|---|---|
| Abrir página | `browser_navigate` (protegido por URL Guard) |
| Leer página | `browser_snapshot` (incluye referencias clickeables como `e1`, `f29e86`) |
| Interacción | `browser_click` / `type` / `fill` / `press` / `scroll` / `wait` / `back` / `forward` |
| Múltiples pestañas | `browser_tabs` / `open_tab` / `switch_tab` / `close_tab` (aislado por sesión) |
| Captura de pantalla | `browser_screenshot` → adjunto persistente + ContentBlock de `image` (para modelos de visión) |
| JS en la página | `browser_evaluate` (desactivado por defecto; activar explícitamente en YAML / `cordis.patch.yml`) |

---

## Modelo de seguridad

- Solo se permite `http(s)` público; se bloquean direcciones locales, de bucle invertido, link-local y de metadatos en la nube (`packages/browser-playwright/src/url-guard.ts`).
- Se permite por defecto el fake-ip de proxy (`198.18.0.0/15`); los rangos privados reales siguen bloqueados. Se puede desactivar en la tarjeta «Ventana del navegador».
- La puerta de permisos permite por defecto hosts no listados; cambie a «Preguntar» si requiere aprobación manual.
- El módulo anti-detección es ligero y no garantiza eludir todos los sistemas de protección contra bots.

YAML / `cordis.patch.yml` continúan siendo válidos para configuraciones de despliegue; las tarjetas Web escriben en el mismo espacio de nombres de settings.

---

## Responsabilidades de los paquetes

| Paquete | Responsabilidad |
|---|---|
| `@yeesy369/dsh-browser` | Definición del servicio: `ctx.browser` |
| `@yeesy369/dsh-browser-playwright` | Implementación con Playwright + Tarjeta «Ventana del navegador» |
| `@yeesy369/dsh-tool-browser` | Herramientas `browser_*` expuestas al modelo |
| `@yeesy369/dsh-web-permission` | Puerta de permisos `tools/pre-execute` + Tarjeta «Puerta de permisos web» |
| `@yeesy369/dsh-browser-settings` | Panel de barra lateral opcional |

---

## Opcional: YAML / Configuración avanzada

La mayoría de las opciones deben modificarse en las tarjetas de la interfaz web. Lo siguiente solo se utiliza para despliegues automatizados o campos aún no integrados en las tarjetas:

```yaml
# $DSH_HOME/settings.yaml — web-permission (actualización en caliente)
web-permission:
  defaultAction: ask
  remember: true
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: browser-playwright
  config:
    windowVisibility: visible
    stealth: true
    allowFakeIp: true
- id: tool-browser
  config:
    evaluate: false
```

---

## Desarrollo

```sh
pnpm install
pnpm build && pnpm typecheck && pnpm test
```

Documentación: [Arquitectura](./docs/architecture.md) · [Contribución y lanzamientos](./CONTRIBUTING.md) · [AGENTS](./AGENTS.md) · [Licencia MIT](./LICENSE)

Desinstalación:

```sh
dsh plugin --profile web remove \
  @yeesy369/dsh-browser-playwright \
  @yeesy369/dsh-tool-browser \
  @yeesy369/dsh-web-permission
```
