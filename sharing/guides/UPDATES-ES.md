# Actualizaciones de LEÓN Home

## Para quien usa la Raspberry

En Inicio abre **Actualizaciones**. La Raspberry busca versiones publicadas periódicamente;
también puedes tocar **Buscar actualizaciones**.

Cuando haya una versión compatible verás su número y las mejoras. Pulsa **Aceptar e instalar**,
lee la confirmación y toca **Instalar ahora**. Mantén la Raspberry encendida. El panel puede
reiniciarse brevemente; volverá a conectar. Pi-hole se administra por separado y no se reinicia
para actualizar LEÓN.

La Raspberry verifica la firma y el contenido antes de activar una versión. Conserva la versión
anterior y la recupera si la nueva no supera las comprobaciones. Si se necesita ayuda, el panel
lo dirá. No desconectes la alimentación para intentar arreglar una actualización.

Si aparece una **actualización de mantenimiento**, pide ayuda. La base privilegiada que verifica
las firmas, el sistema operativo, Pi-hole y Tailscale no se sustituyen silenciosamente con una
actualización normal del panel. Su mantenimiento necesita una intervención administrativa
separada. Esto también se aplica a cambiar la clave de firma o soportar otra versión del sistema.

## Para quien publica y mantiene

El repositorio público contiene una distribución limpia, sin historial ni configuración del
laboratorio personal. Los archivos de cada casa quedan fuera de las versiones. El producto
objetivo inicial es Raspberry Pi4, ARM64, Debian13; no se compila en el equipo del usuario final.

1. Cambia el código y ejecuta las comprobaciones locales/CI. Revisa compatibilidad y dependencias.
2. Construye web y el ejecutable ARM64 en el entorno de desarrollo. Revisa el contenido público.
3. Usa una versión nueva y un número de secuencia mayor. Prepara notas claras en español.
4. Construye el paquete y firma su manifiesto con la herramienta local. La clave privada se
   conserva en el Llavero del Mac; publica solo la clave pública y su huella. No subas material
   de firma privado, contraseñas, inventarios ni archivos de configuración de casas.
5. Publica una Release estable con `manifest.json`, `manifest.sig`, `leon-home-arm64.tar.gz`,
   `bootstrap.tar.gz` y `release-key.pem`. Un borrador o una prerelease no se ofrece como estable.
6. La Pi consulta Releases de su repositorio configurado. La descarga por sí sola no instala.
   Puedes ejecutar `check-updates` por el acceso limitado de soporte; el dueño acepta desde el panel.

El manifiesto autentica tanto el paquete de aplicación como el archivo de instalación. El
updater solo puede activar el conjunto fijo de archivos de aplicación en un árbol de versión
nuevo; no reemplaza configuración, llaves ni archivos del sistema. Rechaza versiones anteriores,
secuencias repetidas, rutas extra, enlaces y contenidos incompatibles. Mantiene como máximo la
versión activa y la anterior tras una actualización correcta.

Una modificación de la base privilegiada cambia su identificador de compatibilidad y produce
un aviso de mantenimiento; no fuerces el cambio para saltarte esa comprobación. La clave de
firma y su recuperación deben formar parte del plan del mantenedor: perderla impide firmar
nuevas versiones aceptables sin volver a establecer confianza con cada instalación.

## Recuperación

Si falla la activación, se restaura el enlace a la versión anterior y se reinicia el panel.
Un marcador de transacción permite recuperar una activación interrumpida al arrancar de nuevo
el servicio de actualizaciones. Los datos de la casa viven fuera de las versiones y no se
rebobinan como parte de esta operación.

Si el propio servicio de mantenimiento no arranca, conserva el panel y DNS disponibles donde
sea posible y usa una sesión administrativa autorizada para revisar el equipo. La copia local
no sustituye un respaldo fuera de la microSD. No publiques logs que contengan datos de la casa.
