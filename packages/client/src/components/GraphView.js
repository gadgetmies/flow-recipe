// Force graph of the plan items and their `dependencies` (kept from v1, now fed by the plan).

import { useMemo, useRef } from 'react'
import { Box, Typography } from '@mui/material'
import ForceGraph2D from 'react-force-graph-2d'
import { allItems } from '../utils/plan'

export function graphFromPlan(plan) {
  const items = allItems(plan)
  const ids = new Set(items.map((i) => i.uuid))
  const nodes = items.map((i) => ({
    id: i.uuid,
    title: i.title,
    kind: i.kind,
    done: i.status === 'done',
    inputNames: Array.from(new Set(i.inputsFrom.map((h) => h.outputId))),
  }))
  const links = items.flatMap((i) => (i.dependencies || []).filter((d) => ids.has(d)).map((d) => ({ source: d, target: i.uuid })))
  return { nodes, links }
}

export default function GraphView({ plan, onSelect }) {
  const graphRef = useRef()
  const graph = useMemo(() => graphFromPlan(plan), [plan])

  if (graph.nodes.length === 0) {
    return (
      <Box padding={2}>
        <Typography>No graph data available</Typography>
      </Box>
    )
  }

  const incoming = (id) => graph.links.filter((l) => (l.target.id || l.target) === id).length

  return (
    <Box sx={{ height: 'calc(100vh - 120px)', width: '100%' }}>
      <ForceGraph2D
        ref={graphRef}
        graphData={graph}
        nodeLabel={(node) => node.title || node.id}
        nodeColor={(node) => (node.done ? '#1ee9a5' : '#e91e63')}
        linkColor={() => 'rgba(0,0,0,0.2)'}
        linkDirectionalArrowLength={6}
        linkDirectionalArrowRelPos={1}
        linkDirectionalArrowColor={() => 'rgba(0,0,0,0.3)'}
        nodeVal={(node) => Math.max(3, Math.sqrt(incoming(node.id) + 1) * 3)}
        cooldownTicks={100}
        onNodeClick={(node) => {
          if (onSelect) onSelect(node.id)
          const el = document.getElementById('task-' + node.id)
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const label = node.title || node.id
          const fontSize = 10 / globalScale
          const inputFontSize = 8 / globalScale
          ctx.font = `${fontSize}px Sans-Serif`
          const textWidth = ctx.measureText(label).width
          const inputText = (node.inputNames || []).join(', ')
          let inputTextWidth = 0
          if (inputText) {
            ctx.font = `${inputFontSize}px Sans-Serif`
            inputTextWidth = ctx.measureText(inputText).width
          }
          const maxWidth = Math.max(textWidth, inputTextWidth)
          const totalHeight = fontSize + (inputText ? inputFontSize + fontSize * 0.1 : 0)
          const bckgDimensions = [maxWidth, totalHeight].map((n) => n + fontSize * 0.2)

          ctx.fillStyle = node.done ? 'rgba(30, 233, 165, 0.9)' : 'rgba(255, 255, 255, 0.9)'
          ctx.fillRect(node.x - bckgDimensions[0] / 2, node.y - bckgDimensions[1] / 2, ...bckgDimensions)
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillStyle = '#333'
          const verticalOffset = inputText ? -inputFontSize / 2 : 0
          ctx.font = `${fontSize}px Sans-Serif`
          ctx.fillText(label, node.x, node.y + verticalOffset)
          if (inputText) {
            ctx.font = `${inputFontSize}px Sans-Serif`
            ctx.fillStyle = '#666'
            ctx.fillText(inputText, node.x, node.y + fontSize / 2 + inputFontSize / 2 + fontSize * 0.05)
          }
          node.__bckgDimensions = bckgDimensions
        }}
        nodePointerAreaPaint={(node, color, ctx) => {
          ctx.fillStyle = color
          const d = node.__bckgDimensions
          if (d) ctx.fillRect(node.x - d[0] / 2, node.y - d[1] / 2, ...d)
        }}
      />
    </Box>
  )
}
