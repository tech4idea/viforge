import { PRODUCT_PROFILES, resolveProductProfile } from '@viforge/shared';

type ImportMetaWithViteEnv = ImportMeta & {
  env?: {
    VIFORGE_PRODUCT?: string;
  };
};

export const ACTIVE_PRODUCT_PROFILE = resolveProductProfile(
  (import.meta as ImportMetaWithViteEnv).env?.VIFORGE_PRODUCT,
);

export const SELECTABLE_PRODUCT_PROFILES = Object.values(PRODUCT_PROFILES);
