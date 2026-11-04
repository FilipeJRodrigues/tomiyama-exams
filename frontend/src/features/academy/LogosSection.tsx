import { SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';

import { MOBILE_QUERY } from '../../app/breakpoints';
import { LogoSlotPanel } from './LogoSlotPanel';
import { LOGO_SLOTS } from './logoModel';

const LOGOS_TITLE_ID = 'academy-logos-title';

/**
 * The "Logos" section of § 6.6 (RN012), below the academy data: the main and the secondary
 * logo of the certificate, side by side on wide screens and one under the other on the phone
 * (and at 200% zoom). The logos have their own routes (`/settings/logos/{slot}`): they never
 * go with the academy data form.
 */
export function LogosSection() {
  const isMobile = useMediaQuery(MOBILE_QUERY, false, { getInitialValueInEffect: false });
  return (
    <Stack component="section" gap="md" mt="lg" aria-labelledby={LOGOS_TITLE_ID}>
      <Title order={2} size="h3" id={LOGOS_TITLE_ID}>
        Logos
      </Title>
      <Text size="sm">
        O logo principal vai no canto superior esquerdo do certificado e o secundário no direito.
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg">
        {LOGO_SLOTS.map((slot) => (
          <LogoSlotPanel key={slot} slot={slot} fullScreenDialog={isMobile} />
        ))}
      </SimpleGrid>
    </Stack>
  );
}
