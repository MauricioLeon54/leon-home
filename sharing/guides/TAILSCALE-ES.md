# Tailscale y soporte entre dos casas

Cada casa conserva su cuenta, Raspberry y DNS. Compartir una máquina no requiere unir los
usuarios en un tailnet. El responsable de soporte no necesita la aplicación de Mac de LEÓN.

1. En la cuenta del dueño, comparte **solo la Raspberry** con la cuenta del responsable de soporte.
   Entrega la invitación en privado y acepta con la identidad correcta. No publiques enlaces de
   invitación ni claves de autenticación en GitHub.
2. Ajusta los permisos en ambos tailnets. En el del dueño permite al teléfono del dueño DNS
   TCP/UDP53 y HTTPS443 hacia esa Pi; al responsable de soporte, solo TCP22 hacia esa Pi.
   En el tailnet de soporte permite salida a esa Pi compartida por TCP22.
3. Revisa las reglas amplias existentes. Añadir una regla estrecha no cancela una regla anterior
   que permita `*` a `*`. Valida pruebas que denieguen a soporte443/53 y otros dispositivos.
4. Usa OpenSSH con llave propia y host verificado. Compartir por Tailscale no elimina la
   autenticación SSH. No actives Tailscale SSH ni copies llaves de otras máquinas por conveniencia.

Este fragmento es **un ejemplo de grants**, no una política completa para pegar encima de la
actual. Los correos y la IP son de ejemplo; utiliza los de la nueva instalación en su archivo
privado y conserva las reglas legítimas que necesite esa cuenta:

```json
{
  "grants": [
    {
      "src": ["owner@example.test"],
      "dst": ["100.64.0.2"],
      "ip": ["tcp:443", "tcp:53", "udp:53"]
    },
    {
      "src": ["support@example.test"],
      "dst": ["100.64.0.2"],
      "ip": ["tcp:22"]
    }
  ]
}
```

Tailscale limita la red; LEÓN comprueba por separado quién es el dueño del panel. La edición
familiar recibe HTTP por un socket Unix privado: un usuario SSH de soporte no puede falsificar
cabeceras de dueño conectándose a un puerto local abierto.

## Qué puede hacer soporte

La llave configurada abre una cuenta separada `leon-support` con un comando forzado:

```sh
ssh leon-support@NOMBRE_COMPLETO_DE_LA_PI status
ssh leon-support@NOMBRE_COMPLETO_DE_LA_PI check-updates
ssh leon-support@NOMBRE_COMPLETO_DE_LA_PI restart-panel
ssh leon-support@NOMBRE_COMPLETO_DE_LA_PI restart-updates
```

Antes de la primera conexión, fija la huella SSH por una vía confiable y usa comprobación
estricta de host. La llave privada permanece en el equipo del responsable. La cuenta no abre
shell, SFTP, túneles ni acepta paquetes o comandos arbitrarios. Los reinicios están limitados a
esos dos servicios. Antes de reiniciar consulta el estado; evita interrumpir una instalación.
El dueño confirma las instalaciones en su panel. Soporte no puede enviar la operación de
aceptación al servicio de actualizaciones.

Si hace falta administrar el sistema operativo o cambiar la base protegida del instalador,
se necesita una sesión administrativa aparte autorizada por el dueño. Este acceso de soporte
no equivale a entregar root permanente. Conserva el usuario/contraseña de recuperación local.

Para revocar soporte, quita la compartición y su regla de acceso en Tailscale, y retira la llave
autorizada de `leon-support` con el administrador local. No afecta al acceso del dueño al panel.

Fuentes: [compartición de dispositivos](https://tailscale.com/kb/1084/sharing),
[cuentas separadas frente a invitaciones](https://tailscale.com/docs/reference/inviting-vs-sharing),
[identidad de Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).
