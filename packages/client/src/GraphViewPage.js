import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { findFinalOutputId, findTaskProducing } from './recipeTools'
import { expandNode, scheduleItemsInTimelines } from './timelineScheduler'
import { GraphView } from './App'
import { Box, Typography, Container, createTheme, ThemeProvider, CssBaseline } from '@mui/material'
import { pink, purple } from '@mui/material/colors'

const SERVER_URL = process.env.REACT_APP_SERVER_URL || 
  (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3001')

const theme = createTheme({
  palette: {
    background: {
      default: '#e7ecf8',
    },
    primary: pink,
    secondary: purple,
  },
})

function GraphViewPage() {
  const [searchParams] = useSearchParams()
  const recipeName = searchParams.get('recipe')
  const [recipe, setRecipe] = useState(null)
  const [title, setTitle] = useState('')
  const [dependencyGraph, setDependencyGraph] = useState({ nodes: [], links: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!recipeName) {
      setError('Recipe parameter is required. Use ?recipe=recipe-name')
      setLoading(false)
      return
    }

    const loadRecipe = async () => {
      try {
        setLoading(true)
        const response = await fetch(`${SERVER_URL}/api/recipes/${recipeName}`)
        if (!response.ok) {
          throw new Error(`Failed to load recipe: ${response.statusText}`)
        }
        const xmlText = await response.text()
        const parser = new DOMParser()
        const recipeDoc = parser.parseFromString(xmlText, 'text/xml')
        setRecipe(recipeDoc)
      } catch (error) {
        console.error('Failed to load recipe:', error)
        setError(error.message || 'Failed to load recipe')
        setLoading(false)
      }
    }
    loadRecipe()
  }, [recipeName])

  useEffect(() => {
    if (!recipe) {
      return
    }
    const titleElement = recipe.querySelector('title')
    if (titleElement) {
      setTitle(titleElement.innerHTML)
    }
  }, [recipe])

  useEffect(() => {
    if (!recipe) {
      return
    }

    try {
      const scale = 1
      const newTimelines = [[]]
      
      const finalOutputId = findFinalOutputId(recipe)
      const lastTask = findTaskProducing(recipe, finalOutputId)

      if (!lastTask) {
        throw new Error('Could not find final task')
      }

      let xPathResult = recipe.evaluate('(//task)', recipe, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
      for (let i = 0; i < xPathResult.snapshotLength; ++i) {
        const node = xPathResult.snapshotItem(i)
        expandNode(recipe, node, scale)
      }

      xPathResult = recipe.evaluate(
        '(//task|//ingredient|//tool|//ns:task)',
        recipe,
        function (prefix) {
          if (prefix === 'ns') {
            return 'http://www.w3.org/1999/xhtml'
          } else {
            return null
          }
        },
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      )
      for (let i = 0; i < xPathResult.snapshotLength; ++i) {
        const node = xPathResult.snapshotItem(i)
        node.setAttribute('uuid', i)
      }

      scheduleItemsInTimelines(
        recipe,
        [{ uuid: finalOutputId, task: lastTask, amountsLeft: { [finalOutputId]: scale } }],
        newTimelines,
        0,
        false
      )

      const graph = newTimelines.reduce(
        (g, timeline) => {
          timeline.forEach(({ uuid, title, dependencies, task }) => {
            const dependencyInputNames = dependencies.map(d => d.input?.name).filter(Boolean)
            
            const ingredientInputNames = []
            if (task) {
              const inputs = task.querySelectorAll('input')
              inputs.forEach((input) => {
                const inputId = input.getAttribute('ref')
                const referencedElement = recipe.getElementById(inputId)
                if (referencedElement && referencedElement.tagName === 'ingredient') {
                  const ingredientName = Array.from(referencedElement.childNodes)
                    .filter((node) => node.nodeType === Node.TEXT_NODE)
                    .map((node) => node.textContent)
                    .join('')
                    .trim()
                  if (ingredientName) {
                    ingredientInputNames.push(ingredientName)
                  }
                }
              })
            }
            
            const inputNames = [...new Set([...dependencyInputNames, ...ingredientInputNames])]
            g?.nodes.push({ id: uuid, title: `${uuid}-${title}`, inputNames })
            dependencies.forEach(({ uuid: iuuid }) => g?.links.push({ source: iuuid, target: uuid }))
          })
          return g
        },
        { nodes: [], links: [] }
      )

      setDependencyGraph(graph)
      setLoading(false)
    } catch (error) {
      console.error('Error processing recipe:', error)
      setError(error.message || 'Error processing recipe')
      setLoading(false)
    }
  }, [recipe])

  if (loading) {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Container sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Typography>Loading recipe graph...</Typography>
        </Container>
      </ThemeProvider>
    )
  }

  if (error) {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Container sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Typography color="error">{error}</Typography>
        </Container>
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container sx={{ minHeight: '100vh', py: 2 }}>
        <Box sx={{ mb: 2 }}>
          <Typography variant="h4" gutterBottom>
            {title || 'Recipe Graph'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Recipe: {recipeName}
          </Typography>
        </Box>
        <GraphView dependencyGraph={dependencyGraph} completedTasks={[]} />
      </Container>
    </ThemeProvider>
  )
}

export default GraphViewPage

