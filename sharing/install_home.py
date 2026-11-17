#!/usr/bin/env python3
"""Guided installation on a fresh Pi, or a non-mutating compatibility plan."""

import argparse
import getpass
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from leon_home.contracts import ReleaseError, Site, read_json  # noqa: E402
from leon_home.install import install, preflight, support_key  # noqa: E402

MESSAGES = {
    'existingInstallation': 'Esta Raspberry ya tiene una instalación. No la sobrescribimos. Si una instalación nueva se interrumpió, repite exactamente el mismo paquete con --resume.',
    'incompatible': 'Necesitas Raspberry Pi OS Lite de 64 bits basado en Debian 13.',
    'invalidSignature': 'La firma o la huella de la clave no coinciden. Detén la instalación y revisa el paquete con quien te ayuda.',
    'missingPrerequisite': 'Falta un requisito: instala Pi-hole v6, Tailscale, Unbound, nftables y OpenSSL según el manual.',
    'wrongTailnet': 'Tailscale debe estar conectado con la cuenta del dueño de esta casa, sin etiquetas de dispositivo.',
    'missingInterface': 'No encontramos una dirección IPv4 en la conexión Ethernet seleccionada.',
    'incompatibleSubnet': 'La red no cumple los límites del inventario. Pide ayuda antes de continuar.',
    'invalidSupportKey': 'La llave de soporte debe ser una llave pública Ed25519 válida.',
    'rootRequired': 'Para instalar, ejecuta este asistente con sudo.',
    'invalidPassword': 'La contraseña de aplicación de Pi-hole no tiene un formato válido.',
}


def wizard(repository):
    print('LEÓN Home · Una Raspberry para tu casa\n')
    owner = input('Correo de la cuenta Tailscale del dueño: ').strip().lower()
    support = (
        input('Correo Tailscale del responsable de soporte (vacío para omitir): ').strip().lower()
    )
    hostname = input('Nombre para esta Raspberry [leon-casa]: ').strip() or 'leon-casa'
    interface = input('Interfaz Ethernet [eth0]: ').strip() or 'eth0'
    return {
        'schemaVersion': 1,
        'owner': owner,
        'supportLogin': support,
        'repository': repository,
        'hostname': hostname,
        'interface': interface,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--key', type=Path, required=True)
    parser.add_argument('--fingerprint', required=True)
    parser.add_argument('--site', type=Path)
    parser.add_argument('--repository', default='MauricioLeon54/leon-home')
    parser.add_argument('--support-key', type=Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--resume', action='store_true')
    options = parser.parse_args()
    try:
        value = read_json(options.site) if options.site else wizard(options.repository)
        site = Site.parse(value)
        candidate, _ = preflight(
            site, options.bundle, options.key, options.fingerprint, options.resume
        )
        public = support_key(options.support_key) if options.support_key else None
        if site.support_login and public is None:
            raise ReleaseError('invalidSupportKey')
        print(f'Paquete verificado: LEÓN Home {candidate["version"]}.')
        print(
            'Plan: panel privado, inventario, DNS protegido y actualizaciones con tu aprobación.\nEl router, DHCP y DNS de tus otros dispositivos requieren una configuración posterior y separada.'
        )
        if not options.apply:
            print(
                'Comprobación terminada. No se hicieron cambios. Añade --apply cuando estés listo.'
            )
            return
        if os.geteuid() != 0:
            raise ReleaseError('rootRequired')
        password = getpass.getpass('Contraseña de APLICACIÓN de Pi-hole (no se mostrará): ')
        install(
            site,
            value,
            options.bundle,
            options.key,
            options.fingerprint,
            Path(__file__).resolve().parent,
            password,
            public,
            options.resume,
        )
        password = ''
        print(
            'Instalación terminada. Abre la dirección HTTPS de esta Raspberry desde tu teléfono con Tailscale.\nContinúa con la prueba DNS de un equipo y las reglas de acceso del manual.'
        )
    except ReleaseError as error:
        raise SystemExit(
            MESSAGES.get(
                error.code,
                'No pudimos completar la instalación. Conserva el paquete y revisa el manual con quien te ayuda.',
            )
        ) from None
    except (OSError, ValueError, KeyError):
        raise SystemExit(
            'La comprobación o instalación se interrumpió. Revisa los requisitos y el manual antes de repetir.'
        ) from None


if __name__ == '__main__':
    main()
