# Instalar LEÓN Home en otra casa

Esta guía está pensada para hacer la primera instalación acompañado por quien te da soporte.
Después usarás el panel desde el teléfono. No necesitas la aplicación de Mac, Docker, Node ni
compilar Rust en la Raspberry.

## Antes de la visita

Necesitas una Raspberry Pi 4 de 2 GB, fuente adecuada de 5 V/3 A, Ethernet, microSD fiable y Raspberry Pi OS
Lite **de 64 bits, Debian 13**. Guarda las contraseñas de recuperación en tu propio gestor de
contraseñas. Una pantalla no es necesaria si preparas SSH con Raspberry Pi Imager.

Usa tu propia cuenta de Tailscale y protege su inicio de sesión. No copies la identidad Tailscale,
llaves privadas, respaldos o configuración de la Raspberry de otra casa.

Quien te ayuda prepara: paquete de aplicación firmado, archivo de instalación, clave pública de
firma y su huella confirmada por un canal independiente. También prepara una llave SSH exclusiva
de soporte; solo se copia su parte **pública**. La llave privada se queda con quien da soporte.

## Preparar el sistema

1. Graba Raspberry Pi OS Lite de 64 bits con Imager. Usa un nombre propio para esta Raspberry,
   activa SSH con una llave y configura un usuario de recuperación con contraseña fuerte.
   Mantén una vía de recuperación local; no desactives accesos sin comprobar la llave.
2. Conecta Ethernet y la fuente. Reserva su dirección en el DHCP del router; no cambies todavía
   el DNS que entrega el router. Verifica la identidad SSH con la huella mostrada por el equipo
   o por el material de preparación confiable. No aceptes una huella desconocida automáticamente.
3. Actualiza el sistema e instala requisitos desde los repositorios de su sistema:
   `sudo apt update` y después `sudo apt install python3 openssl nftables unbound dns-root-data openssh-server sudo`.
4. Instala **Pi-hole v6** con el [procedimiento oficial](https://docs.pi-hole.net/main/basic-install/).
   Descarga y revisa su instalador antes de ejecutarlo. Conserva tu contraseña de administración.
   En su panel crea una contraseña de aplicación para las estadísticas de LEÓN; no la mandes por chat.
5. Instala [Tailscale para Raspberry Pi](https://tailscale.com/download/linux), entra con la cuenta
   del dueño de esta casa y confirma que la Raspberry aparece en esa cuenta. Conserva sin activar
   exit node, rutas de subred y Funnel. Activa HTTPS para el panel privado cuando Tailscale lo solicite.

La instalación de LEÓN configurará Pi-hole en loopback para su panel, upstream cifrado con
Unbound y un filtro de entrada DNS limitado a la LAN y Tailscale. No cambia el DNS de los otros
dispositivos ni la política de acceso de Tailscale por su cuenta.

## Verificar el paquete antes de ejecutarlo

Recibe estos archivos de la versión publicada:

- `manifest.json`, `manifest.sig`, `leon-home-arm64.tar.gz`, `bootstrap.tar.gz`, `release-key.pem`.
- La huella SHA-256 de la clave pública, confirmada directamente con tu responsable de soporte.

El paquete inicial establece la confianza de las próximas versiones. Antes de extraer o ejecutar
el instalador, el operador verifica la huella de `release-key.pem`, verifica `manifest.sig` con
OpenSSL y compara el SHA-256 de `bootstrap.tar.gz` con **el manifiesto ya verificado**. Un hash
publicado al lado de un archivo no sustituye una firma verificada con una clave confiable.

```sh
openssl pkey -pubin -in release-key.pem -outform DER | sha256sum
openssl pkeyutl -verify -pubin -inkey release-key.pem -sigfile manifest.sig -rawin -in manifest.json
sha256sum bootstrap.tar.gz
```

La primera línea debe coincidir con la huella entregada por soporte. La última debe coincidir
con `bootstrapSha256` en el manifiesto firmado. Solo después extrae `bootstrap.tar.gz` en una
carpeta nueva y entra a esa carpeta.

## Ejecutar el asistente

La carpeta del paquete firmado y la del instalador son distintas. Sustituye las rutas y la
huella con los valores verificados de esta instalación:

```sh
sudo python3 -I install_home.py \
  --bundle /ruta/al/paquete \
  --key /ruta/al/paquete/release-key.pem \
  --fingerprint HUELLA_CONFIRMADA \
  --support-key /ruta/a/la/llave-publica-soporte.pub
```

Sin `--apply` solo comprueba compatibilidad. No instala ni modifica configuración. Pide el
correo Tailscale del dueño, el correo de soporte, nombre e interfaz. Usa exactamente los mismos
valores cuando añadas `--apply` para instalar. La contraseña de aplicación de Pi-hole se pide
localmente, no se muestra y queda únicamente en esta Raspberry.

Si prefieres no dar acceso de soporte, deja vacío su correo y omite `--support-key`.

El asistente rechaza una Raspberry que ya tenga LEÓN; no sirve para clonar ni sobrescribir otra
casa. Si una instalación nueva se interrumpe, conserva el mismo paquete, huella y datos; el
operador puede reanudarla con `--resume --apply`. No borres archivos de otra instalación para
forzar la comprobación. Una instalación inicial interrumpida necesita revisión del operador.

## Abrir el panel y activar DNS

1. Conecta Tailscale en tu teléfono. Abre la dirección HTTPS de **tu** Raspberry que muestra
   `tailscale serve status`. Añádela a la pantalla de inicio desde Safari o tu navegador.
2. Revisa Inicio y Red. La primera lectura tarda un poco. El router de tu casa puede no permitir
   medir tráfico o controlar puertos; esas funciones permanecen sin habilitar hasta comprobarlo.
3. Prueba DNS en un solo equipo de casa. Pon como DNS manual la dirección LAN reservada de tu Pi.
   Comprueba navegación y filtrado. Para revertir, vuelve a DNS automático.
4. Para filtrar en tu teléfono fuera de casa, configura en **tu tailnet** la IP Tailscale de tu Pi
   como servidor DNS y activa Override DNS. El teléfono debe aceptar Tailscale DNS y tener
   Exit Node en None. Es una decisión que puede afectar a tus otros equipos de ese tailnet.
5. Con Wi-Fi apagado, verifica una web y el panel. Si tu casa pierde luz o Internet, desactiva el
   DNS de Tailscale o desconecta Tailscale temporalmente. Recuperar DNS automático debe quedar
   explicado y probado antes de hacer el cambio para toda la casa.

Pi-hole filtra DNS; no bloquea todo anuncio ni sustituye navegación segura. Algunas aplicaciones,
DNS propios y DNS IPv6 anunciados por el router pueden evitar el filtro. Cambiar el DNS de todo
el hogar o su router requiere una configuración posterior, específica de ese equipo.

## Acceso de soporte y recuperación

Sigue [Tailscale y soporte](TAILSCALE-ES.md) para compartir únicamente esta Raspberry, limitar
los puertos y verificar la llave SSH del equipo. El acceso predeterminado de soporte tiene
comandos limitados y no acepta las actualizaciones en tu lugar.

Guarda una exportación Teleporter de Pi-hole en tu propio almacenamiento seguro, además de las
credenciales y el material de recuperación. La copia local de la versión anterior ayuda a
revertir una actualización, pero no protege frente a una microSD dañada. Una fuente adecuada,
SSD/UPS y un respaldo externo resuelven problemas distintos.
