import { resolveProductProfile } from '@viwork/shared';

type ImportMetaWithViteEnv = ImportMeta & {
  env?: {
    VIWORK_PRODUCT?: string;
  };
};

export const ACTIVE_PRODUCT_PROFILE = resolveProductProfile(
  (import.meta as ImportMetaWithViteEnv).env?.VIWORK_PRODUCT,
);
