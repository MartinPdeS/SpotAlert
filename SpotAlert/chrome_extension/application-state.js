export const APPLICATION_STAGES = ['opening', 'selecting-date', 'waiting-update', 'starting', 'filling', 'awaiting-review', 'needs-details', 'verification', 'failed', 'cancelled'];
export function applicationStage(update, previous) {
  if (update.status === 'stopped') {
    if (update.kind === 'cancelled') return 'cancelled';
    if (['verification', 'login', 'account-exists'].includes(update.kind)) return 'verification';
    if (['missing', 'validation'].includes(update.kind)) return 'needs-details';
    if (['error', 'waiting', 'interrupted', 'navigation', 'date', 'availability'].includes(update.kind)) return 'failed';
    return 'awaiting-review';
  }
  const stage = update.stage || (update.status === 'running' ? 'opening' : previous || 'opening');
  if (!APPLICATION_STAGES.includes(stage)) throw new Error('Unknown application stage.');
  return stage;
}
export function applicationRecovery(application) {
  const kind = application.kind;
  return {
    openLabel: ['verification', 'login', 'account-exists'].includes(kind) ? 'Complete verification or sign in' : ['missing', 'validation'].includes(kind) ? 'Correct details on website' : 'Open application',
    retry: false,
    edit: ['missing', 'validation'].includes(kind),
  };
}
