import type { ComponentType, SVGProps } from 'react';
import {
  AudioIcon,
  BuildingIcon,
  ChatIcon,
  DashboardIcon,
  KeyIcon,
  ProductIcon,
  SettingsIcon,
  TextIcon,
} from '@/components/ui/Icons';

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Aparece na bottom nav (mobile). */
  primary: boolean;
  /** Só visível para o dono da plataforma (super-admin). */
  superadminOnly?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Conexões', icon: DashboardIcon, primary: true },
  { to: '/conversas', label: 'Contatos', icon: ChatIcon, primary: true },
  { to: '/produtos', label: 'Produtos', icon: ProductIcon, primary: true },
  { to: '/conta', label: 'Conta', icon: SettingsIcon, primary: true },
  { to: '/audios', label: 'Áudios', icon: AudioIcon, primary: false },
  { to: '/disparos', label: 'Disparos', icon: TextIcon, primary: false },
  { to: '/scripts', label: 'Scripts', icon: TextIcon, primary: false },
  { to: '/keywords', label: 'Keywords', icon: KeyIcon, primary: false },
  { to: '/painel', label: 'Painel', icon: DashboardIcon, primary: false },
  { to: '/admin', label: 'Empresas', icon: BuildingIcon, primary: false, superadminOnly: true },
];
