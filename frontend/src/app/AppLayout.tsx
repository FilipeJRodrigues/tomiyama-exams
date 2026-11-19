import {
  ActionIcon,
  AppShell,
  Badge,
  Burger,
  Button,
  Group,
  Image,
  NavLink,
  Stack,
  Text,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure, useMediaQuery, useWindowEvent } from '@mantine/hooks';
import { IconLogout, IconMoon, IconSun } from '@tabler/icons-react';
import { useRef } from 'react';
import { NavLink as RouterNavLink, Outlet, useNavigate } from 'react-router';

import logo from '../assets/brand/tomiyama-logo-96.webp';
import { ROLE_LABELS } from '../auth/types';
import { useAuth } from '../auth/useAuth';
import { HEADER_SCROLL_PADDING, useScrollPadding } from '../features/exam/focus';
import { MOBILE_QUERY } from './breakpoints';
import { navItemsFor, paths } from './navigation';
import { DISPLAY_FONT_WEIGHT } from './theme';

const NAV_ID = 'main-navigation';

const NO_WRAP = { whiteSpace: 'nowrap' } as const;

/** Shown at about 40 px; the file has 96 px, sharp on high-density screens (`logo.md`). */
const LOGO_SIZE = 40;

/**
 * The brand at the left of the header (skill `tomiyama-design`, "Cabeçalho e menu lateral"):
 * the round logo, "Tomiyama" in the display font and "Área de exames" in the secondary text,
 * which leaves below `sm` (phone, 200% zoom). Neither is a heading: the first heading of the
 * page is the `h1` of the screen.
 *
 * Everything fits from 343 px wide. Below that (320 px, 400% zoom) the name is the one thing
 * that gives way, cut with an ellipsis, so the Tema and Sair buttons stay whole.
 */
function Brand() {
  return (
    <>
      <Image
        src={logo}
        alt="Academia Tomiyama"
        width={LOGO_SIZE}
        height={LOGO_SIZE}
        w={LOGO_SIZE}
        h={LOGO_SIZE}
        fit="contain"
      />
      <Group gap="xs" align="baseline" wrap="nowrap" miw={0}>
        <Text
          component="span"
          ff="var(--app-font-display)"
          fw={DISPLAY_FONT_WEIGHT}
          fz="h3"
          truncate="end"
        >
          Tomiyama
        </Text>
        <Text component="span" size="sm" c="dimmed" visibleFrom="sm" style={NO_WRAP}>
          Área de exames
        </Text>
      </Group>
    </>
  );
}

function ColorSchemeToggle() {
  const { setColorScheme } = useMantineColorScheme();
  const computed = useComputedColorScheme('light', { getInitialValueInEffect: false });
  const next = computed === 'dark' ? 'light' : 'dark';
  const label = next === 'dark' ? 'Usar tema escuro' : 'Usar tema claro';
  return (
    <ActionIcon
      variant="default"
      size="lg"
      aria-label={label}
      title={label}
      onClick={() => {
        setColorScheme(next);
      }}
    >
      {next === 'dark' ? <IconMoon size={18} aria-hidden /> : <IconSun size={18} aria-hidden />}
    </ActionIcon>
  );
}

export function AppLayout({ useMocks }: { useMocks: boolean }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [opened, { toggle, close }] = useDisclosure(false);
  const isMobile = useMediaQuery(MOBILE_QUERY, false, { getInitialValueInEffect: false });
  const burgerRef = useRef<HTMLButtonElement>(null);

  useWindowEvent('keydown', (event) => {
    if (event.key === 'Escape' && opened) {
      close();
      burgerRef.current?.focus();
    }
  });

  // § 6.7: on every screen under the fixed header, a control focused with Tab or Shift+Tab
  // stays clear of it. The only place that sets the top edge: a screen setting it too would
  // clear it when it leaves. Signed out there is no header, so nothing is set.
  useScrollPadding('top', user ? HEADER_SCROLL_PADDING : null);

  if (!user) return null;

  const handleSignOut = async () => {
    // `signOut` also drops the cached data (see AuthProvider).
    await signOut();
    void navigate(paths.login, { replace: true });
  };

  const items = navItemsFor(user.role);
  const drawerHidden = isMobile && !opened;

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap" gap="sm">
          <Group gap="xs" wrap="nowrap" miw={0}>
            <Burger
              ref={burgerRef}
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
              aria-label={opened ? 'Fechar menu' : 'Abrir menu'}
              aria-expanded={opened}
              aria-controls={NAV_ID}
            />
            <Brand />
            {useMocks && (
              <Badge variant="light" color="orange" visibleFrom="xs">
                Dados simulados
              </Badge>
            )}
          </Group>
          <Group gap="sm" wrap="nowrap">
            {/* Up to 180 px from `sm` to `md`, where the brand takes the room, and 240 px from
                `md`; a longer e-mail is cut with an ellipsis. It is also in the menu. */}
            <Text size="sm" visibleFrom="sm" truncate="end" maw={{ base: 180, md: 240 }}>
              {user.email}
            </Text>
            <ColorSchemeToggle />
            <Button
              variant="default"
              leftSection={<IconLogout size={18} aria-hidden />}
              onClick={() => void handleSignOut()}
            >
              Sair
            </Button>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar
        id={NAV_ID}
        component="nav"
        aria-label="Menu principal"
        p="sm"
        data-drawer-open={isMobile ? String(opened) : undefined}
        inert={drawerHidden}
      >
        <AppShell.Section grow>
          <Stack gap={4}>
            {items.map((item) => (
              <NavLink
                key={item.path}
                component={RouterNavLink}
                to={item.path}
                label={item.label}
                leftSection={<item.icon size={20} aria-hidden />}
                onClick={close}
              />
            ))}
          </Stack>
        </AppShell.Section>
        <AppShell.Section pt="sm">
          <Text size="sm" fw={500} lineClamp={1}>
            {user.email}
          </Text>
          <Text size="sm" c="dimmed">
            {ROLE_LABELS[user.role]}
          </Text>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
