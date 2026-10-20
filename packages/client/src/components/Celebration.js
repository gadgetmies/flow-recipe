// Celebration popup, food particle animation and the GO popup, unchanged from v1.

import { useEffect, useRef } from 'react'
import { Button, Dialog, DialogContent, DialogTitle, Stack, Typography } from '@mui/material'
import confetti from 'canvas-confetti'

const foodEmojis = ['🍰', '🍪', '🎂', '🍕', '🌮', '🍔', '🥐', '🍓', '🍇', '🍎', '🥑', '🍉', '🍌', '🥝', '🍑', '🥨', '🧁', '🥧']

export function FoodParticleAnimation({ active, restartKey }) {
  const canvasRef = useRef(null)
  const confettiInstanceRef = useRef(null)

  useEffect(() => {
    if (!active) {
      if (canvasRef.current && canvasRef.current.parentNode) {
        canvasRef.current.parentNode.removeChild(canvasRef.current)
        canvasRef.current = null
        confettiInstanceRef.current = null
      }
      return
    }

    if (!canvasRef.current) {
      const canvas = document.createElement('canvas')
      canvas.style.position = 'fixed'
      canvas.style.top = '0'
      canvas.style.left = '0'
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      canvas.style.pointerEvents = 'none'
      canvas.style.zIndex = '1600'
      document.body.appendChild(canvas)
      canvasRef.current = canvas
      try {
        confettiInstanceRef.current = confetti.create(canvas, { resize: true, useWorker: false })
      } catch (e) {
        confettiInstanceRef.current = null
      }
    }

    const scalar = 6
    if (confettiInstanceRef.current) {
      try {
        confettiInstanceRef.current({
          spread: 360,
          ticks: 50,
          gravity: 2,
          decay: 0.96,
          flat: true,
          startVelocity: 25,
          shapes: foodEmojis.map((emoji) => confetti.shapeFromText({ text: emoji, scalar })),
          scalar,
        })
      } catch (e) {
        // canvas unavailable (tests)
      }
    }
  }, [active, restartKey])

  return null
}

export function CelebrationPopup({ open, onClose, onRestartAnimation }) {
  const handleClose = (event, reason) => {
    if (reason === 'backdropClick') return
    onClose()
  }
  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 4, textAlign: 'center', padding: 2, position: 'relative', zIndex: 1500 } }}>
      <DialogTitle>
        <Typography component="div" sx={{ fontWeight: 'bold', color: 'primary.main', fontSize: { xs: '1.1rem', sm: '2rem', md: '2.5rem' }, whiteSpace: 'nowrap', px: { xs: 0.5, sm: 2 } }}>
          🎉 Congratulations! 🎉
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Typography variant="h5" sx={{ mb: 2 }}>
          All tasks completed!
        </Typography>
        <Typography variant="body1" sx={{ mb: 3 }}>
          Great teamwork! You've successfully completed the meal together.
        </Typography>
        <Stack direction="row" spacing={2} justifyContent="center">
          <Button variant="contained" color="primary" onClick={() => onRestartAnimation && onRestartAnimation()} size="large">
            Celebrate!
          </Button>
          <Button variant="outlined" color="primary" onClick={handleClose} size="large">
            Dismiss
          </Button>
        </Stack>
      </DialogContent>
    </Dialog>
  )
}

export function GoPopup({ open }) {
  return (
    <Dialog
      open={open}
      maxWidth="sm"
      fullWidth
      disableEscapeKeyDown
      PaperProps={{
        sx: {
          borderRadius: 4,
          textAlign: 'center',
          padding: 4,
          position: 'relative',
          zIndex: 1500,
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          animation: open ? 'goBounce 0.6s ease-out' : 'none',
          '@keyframes goBounce': {
            '0%': { transform: 'scale(0.3)', opacity: 0 },
            '50%': { transform: 'scale(1.1)' },
            '70%': { transform: 'scale(0.9)' },
            '100%': { transform: 'scale(1)', opacity: 1 },
          },
        },
      }}
    >
      <DialogContent sx={{ padding: 0 }}>
        <Typography
          variant="h1"
          component="div"
          sx={{
            fontWeight: 'bold',
            color: 'white',
            fontSize: { xs: '4rem', sm: '6rem', md: '8rem' },
            textShadow: '0 4px 20px rgba(0,0,0,0.3)',
            letterSpacing: '0.1em',
            animation: open ? 'goPulse 1s ease-in-out infinite' : 'none',
            '@keyframes goPulse': { '0%, 100%': { transform: 'scale(1)' }, '50%': { transform: 'scale(1.05)' } },
          }}
        >
          GO!
        </Typography>
      </DialogContent>
    </Dialog>
  )
}
