import { SetMetadata } from '@nestjs/common';

export const ALLOW_EXPIRED_TRIAL_KEY = 'allowExpiredTrial';
/** Route stays available after the trial expired (read-only paths, cancel, company/certificate updates). */
export const AllowExpiredTrial = () => SetMetadata(ALLOW_EXPIRED_TRIAL_KEY, true);
