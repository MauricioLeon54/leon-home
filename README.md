# LEÓN Home

Pi-hole, un panel privado desde el teléfono y un inventario de red para una Raspberry Pi 4 de 2 GB.
Cada casa conserva su propia cuenta de Tailscale, configuración y credenciales. No necesitas
una aplicación de Mac para usarlo.

La primera instalación se hace acompañado por una persona de soporte. Después puedes consultar
el panel y aceptar las nuevas versiones desde el teléfono. Las actualizaciones de aplicación
están firmadas, conservan configuración y guardan una versión anterior para recuperación.

- [Instalación acompañada](sharing/guides/INSTALL-ES.md)
- [Tailscale y soporte limitado](sharing/guides/TAILSCALE-ES.md)
- [Actualizaciones y recuperación](sharing/guides/UPDATES-ES.md)

Las guías están en `sharing/guides/` en el repositorio. Esta es la distribución independiente;
no contiene el historial del laboratorio personal, la app de Mac ni inventarios reales.

## Alcance inicial

Objetivo: Raspberry Pi OS Lite de 64 bits, Debian 13, Pi-hole v6 y Tailscale. El instalador rechaza
una instalación LEÓN existente para evitar sobrescribir otra casa. El panel es privado mediante
Tailscale Serve; no requiere puertos públicos, Funnel ni un servidor web en Internet.

El mapa muestra observaciones, no una topología física garantizada. Medir tráfico o cambiar
puertos depende de cada router y no se habilita automáticamente. Pi-hole filtra DNS y no puede
bloquear todos los anuncios ni proteger por sí solo toda la navegación.

Las actualizaciones normales cubren la aplicación y el inventario. Pi-hole, el sistema operativo,
Tailscale y la base privilegiada de verificación tienen mantenimiento separado. Conservar la
versión previa no sustituye un respaldo externo ni una fuente de alimentación estable.

## Desarrollo

Necesitas Node 24+, pnpm 12.15.0, Python 3.13+, Ruff y Rust según `rust/leon-netmap/rust-toolchain.toml`.
La firma de publicaciones la hace el mantenedor con su clave local; las pruebas generan llaves
temporales y nunca usan una clave de producción.

```sh
pnpm install --frozen-lockfile --ignore-scripts
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
pnpm exec playwright install chromium webkit
pnpm check
pnpm build:netmap
./sharing/test-linux.sh
```

`pnpm build:netmap` requiere un host Docker ARM64 y construye fuera de la Raspberry de uso diario.
Para crear una publicación firmada consulta el manual de actualizaciones. `PUBLIC-EXPORT.json`
registra el contenido de la exportación inicial revisada; no contiene datos de una instalación.

## Estado de la primera versión

Versión inicial para instalación acompañada. Se comprueba en navegadores y en Debian ARM64
con instalación y actualización aisladas. La vinculación real de Tailscale, el DNS de cada casa
y la recuperación del hardware se verifican durante la instalación; no se clonan de otra casa.
El acceso de soporte no sustituye una cuenta administrativa de recuperación del dueño.
