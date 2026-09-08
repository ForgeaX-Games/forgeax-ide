import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApplicationRecoveryBoundary } from '@forgeax/app-shell/react';
import '@forgeax/interface/styles/global.css';
import { ApplicationShell } from '@forgeax/interface/ApplicationShell';
import { startInterfaceApplication } from '@forgeax/interface/application';
import { BrandProvider } from '@forgeax/interface/brand';
import { initI18n, useTranslation } from '@forgeax/interface/i18n';
import { reportError } from '@forgeax/interface/lib/aegis';
import { configureStudioDomainClients } from './integration/interface-store';
import { createRestStudioDomainClients } from './integration/rest-studio-domain-clients';
import { StudioProductRoot } from './product/StudioProductRoot';
import { IDE_PRODUCT_OVERRIDES, bootIdeProductComposition } from './product/studio-composition';

// forgeax-ide is the product assembly, not a replacement product UI. The
// gameplay carrier remains transport infrastructure; it is not the app entry.
document.documentElement.dataset.theme = 'dark';
document.documentElement.classList.add('dark', 'forgeax-ide');
initI18n();
configureStudioDomainClients(createRestStudioDomainClients());

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

async function startStudioProductApplication() {
  await bootIdeProductComposition();
  return startInterfaceApplication(IDE_PRODUCT_OVERRIDES);
}

function IdeApplicationRecoveryBoundary({ children }: { children: ReactNode }) {
  const { t } = useTranslation();

  return (
    <ApplicationRecoveryBoundary
      scope="studio-shell"
      messages={{
        title: t('errorBoundary.fullscreenTitle'),
        hint: t('errorBoundary.fullscreenHint'),
        retry: t('errorBoundary.retry'),
        remount: t('errorBoundary.reloadRegion'),
        reloadApplication: t('errorBoundary.reloadStudio'),
      }}
      onError={(error, info, scope) => reportError(error, info.componentStack, scope)}
      onRevealError={() => {
        (window as unknown as { __forgeaxBoot?: { done(): void } }).__forgeaxBoot?.done();
      }}
    >
      {children}
    </ApplicationRecoveryBoundary>
  );
}

createRoot(root).render(
  <StrictMode>
    <IdeApplicationRecoveryBoundary>
      <BrandProvider>
        <StudioProductRoot start={startStudioProductApplication}>
          {(runtime) => (
            <ApplicationShell runtime={runtime} onboarding={{ enabled: false }} />
          )}
        </StudioProductRoot>
      </BrandProvider>
    </IdeApplicationRecoveryBoundary>
  </StrictMode>,
);
