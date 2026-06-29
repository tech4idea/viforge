import { PRODUCT_PROFILES, resolveProductProfile } from '@viwork/shared';

type ImportMetaWithViteEnv = ImportMeta & {
  env?: {
    VIWORK_PRODUCT?: string;
  };
};

export const ACTIVE_PRODUCT_PROFILE = resolveProductProfile(
  (import.meta as ImportMetaWithViteEnv).env?.VIWORK_PRODUCT,
);

export const SELECTABLE_PRODUCT_PROFILES = Object.values(PRODUCT_PROFILES);
