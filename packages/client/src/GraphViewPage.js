// Standalone graph page: /graph?session=<id> fetches the session's plan and draws its dependency graph.

import { lazy, Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Box, Typography, Container, ThemeProvider, CssBaseline } from '@mui/material'
import theme from './theme'
import { getSession } from './api'
import { isMockMode } from './config'

const GraphView = lazy(() => import('./components/GraphView'))

function Page({ children }) {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container sx={{ minHeight: '100vh', py: 2 }}>{children}</Container>
    </ThemeProvider>
  )
}

function GraphViewPage() {
  const [searchParams] = useSearchParams()
  const sessionId = searchParams.get('session')
  const recipeName = searchParams.get('recipe')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(!!sessionId)

  useEffect(() => {
    if (!sessionId) return undefined
    let cancelled = false
    setLoading(true)
    getSession(sessionId, isMockMode())
      .then((d) => {
        if (cancelled) return
        setData(d)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e.message || 'Failed to load session')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  if (!sessionId) {
    return (
      <Page>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '80vh' }}>
          <Typography color={recipeName ? 'text.primary' : 'error'} textAlign="center">
            {recipeName
              ? `Graphs are built from sessions now: create a session with recipe "${recipeName}" and open /graph?session=<id>.`
              : 'Session parameter is required. Use ?session=<session id>'}
          </Typography>
        </Box>
      </Page>
    )
  }
  if (loading) {
    return (
      <Page>
        <Typography>Loading session graph...</Typography>
      </Page>
    )
  }
  if (error) {
    return (
      <Page>
        <Typography color="error">{error}</Typography>
      </Page>
    )
  }

  const title = (data?.session?.dishes || []).map((d) => d.title || d.recipeId).join(' + ')
  return (
    <Page>
      <Box sx={{ mb: 2 }}>
        <Typography variant="h4" gutterBottom>
          {title || 'Session graph'}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Session: {sessionId} · {data?.plan ? `${data.plan.mode} ${data.plan.status}` : 'no plan yet'}
        </Typography>
      </Box>
      <Suspense fallback={<Typography>Loading graph…</Typography>}>
        <GraphView plan={data?.plan} />
      </Suspense>
    </Page>
  )
}

export default GraphViewPage
