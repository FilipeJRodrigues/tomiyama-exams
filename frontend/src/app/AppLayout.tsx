import {
  ActionIcon,
  AppShell,
  Badge,
  Burger,
  Button,
  Group,
  NavLink,
  Stack,
  Text,
  Title,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure, useMediaQuery, useWindowEvent } from '@mantine/hooks';
import { IconLogout, IconMoon, IconSun } from '@tabler/icons-react';
import { useRef } from 'react';
import { NavLink as RouterNavLink, Outlet, useNavigate } from 'react-router';

import { ROLE_LABELS } from '../auth/types';
import { useAuth } from '../auth/useAuth';
import { MOBILE_QUERY } from './breakpoints';
import { navItemsFor, paths } from './navigation';

const NAV_ID = 'main-navigation';

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
          <Group gap="sm" wrap="nowrap" miw={0}>
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
            <Title order={2} size="h4" lineClamp={1}>
              Tomiyama Exams
            </Title>
            {useMocks && (
              <Badge variant="light" color="orange" visibleFrom="xs">
                Dados simulados
              </Badge>
            )}
          </Group>
          <Group gap="sm" wrap="nowrap">
            <Text size="sm" visibleFrom="sm" lineClamp={1} maw={240}>
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
