import { collectAndPersist } from './air-alerts.mjs';

export default async function collectAlertPhases() {
  const result = await collectAndPersist();
  if (!result.success) {
    throw new Error(result.error?.message || 'Alert phase collection failed');
  }

  console.log(JSON.stringify({
    event: 'alert-phase-collection',
    provider: result.state.providerKey,
    collectedAt: new Date(result.state.lastSuccessAtMs).toISOString(),
    phaseRecords: result.state.records.length,
  }));
}
