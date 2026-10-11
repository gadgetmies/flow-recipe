// Plan overview: per-dish planned serve vs target, fairness per participant, diagnostics and the lanes.

import { Alert, Box, Card, CardContent, Chip, LinearProgress, Stack, Typography } from '@mui/material'
import PlanLanes from './PlanLanes'
import { fmtClock, fmtMinutes } from '../utils/time'
import { diagnosticSeverity, dishTitle, participantName } from '../utils/plan'

function LatenessChip({ late }) {
  const seconds = late || 0
  if (seconds > 0) return <Chip size="small" color="error" label={`${fmtMinutes(seconds)} late`} />
  if (seconds < 0) return <Chip size="small" color="info" label={`${fmtMinutes(-seconds)} early`} />
  return <Chip size="small" color="success" label="on time" />
}

export default function DraftPlan({ plan, session, ownParticipantId, selectedUuid, onSelect }) {
  if (!plan) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography color="text.secondary">Waiting for the plan…</Typography>
      </Box>
    )
  }
  const loads = plan.report?.loads || {}
  const maxLoad = Math.max(1, ...Object.values(loads).flatMap((l) => [l.load || 0, l.expected || 0]))

  return (
    <Box paddingBottom={9}>
      <Stack spacing={2}>
        <Typography variant="h6">
          {plan.status === 'draft' ? 'Draft plan' : 'Plan'}
          <Chip size="small" sx={{ ml: 1 }} label={`${plan.mode} · ${plan.status}`} />
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {fmtClock(plan.startTime)} → {fmtClock(plan.endTime)} · {plan.report ? `fairness ${Math.round((plan.report.fairness || 0) * 100)}%` : ''}
          {plan.report?.switches !== undefined && ` · ${plan.report.switches} switches`}
          {plan.report?.interruptsRisk !== undefined && ` · interrupt risk ${plan.report.interruptsRisk}`}
        </Typography>

        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Dishes
            </Typography>
            <Stack spacing={1}>
              {(plan.dishes || []).map((d) => (
                <Stack key={d.dishId} direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Typography sx={{ minWidth: 120, fontWeight: 500 }}>{dishTitle(session, d.dishId)}</Typography>
                  <Typography variant="body2">
                    target {fmtClock(d.serveTarget)} · planned {fmtClock(d.plannedServe)}
                  </Typography>
                  <LatenessChip late={d.late ?? (d.plannedServe - d.serveTarget) / 1000} />
                  {d.spread > 0 && <Chip size="small" variant="outlined" label={`spread ${fmtMinutes(d.spread)}`} />}
                  {d.holdUsed > 0 && <Chip size="small" variant="outlined" label={`held ${fmtMinutes(d.holdUsed)}`} />}
                </Stack>
              ))}
            </Stack>
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Fairness
            </Typography>
            <Stack spacing={1.5}>
              {(plan.lanes || []).map((lane) => {
                const l = loads[lane.participantId] || { load: lane.report?.load || 0, expected: lane.report?.expectedLoad || 0 }
                const own = lane.participantId === ownParticipantId
                return (
                  <Box key={lane.participantId}>
                    <Stack direction="row" justifyContent="space-between">
                      <Typography variant="body2" sx={{ fontWeight: own ? 700 : 400 }}>
                        {participantName(session, lane.participantId)}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {fmtMinutes(l.load)} of {fmtMinutes(l.expected)} expected
                        {lane.report?.switches !== undefined && ` · ${lane.report.switches} switches`}
                        {lane.report?.timersHeld > 0 && ` · ${lane.report.timersHeld} timers`}
                      </Typography>
                    </Stack>
                    <LinearProgress variant="determinate" value={((l.load || 0) / maxLoad) * 100} sx={{ height: 8, borderRadius: 4, mt: 0.5 }} />
                    <LinearProgress
                      variant="determinate"
                      color="secondary"
                      value={((l.expected || 0) / maxLoad) * 100}
                      sx={{ height: 3, borderRadius: 4, mt: 0.25, opacity: 0.6 }}
                    />
                  </Box>
                )
              })}
            </Stack>
          </CardContent>
        </Card>

        {(plan.diagnostics || []).length > 0 && (
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Diagnostics
              </Typography>
              <Stack spacing={1}>
                {plan.diagnostics.map((d, i) => (
                  <Alert key={`${d.code}-${i}`} severity={diagnosticSeverity(d)}>
                    <b>{d.code}</b> {d.message}
                    {d.dish && ` (${dishTitle(session, d.dish)})`}
                  </Alert>
                ))}
              </Stack>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent sx={{ px: 1 }}>
            <Typography variant="h6" gutterBottom sx={{ px: 1 }}>
              Lanes
            </Typography>
            <PlanLanes plan={plan} session={session} ownParticipantId={ownParticipantId} selectedUuid={selectedUuid} onSelect={onSelect} fixed={false} />
          </CardContent>
        </Card>
      </Stack>
    </Box>
  )
}
