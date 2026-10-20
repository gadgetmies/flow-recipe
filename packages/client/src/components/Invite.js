import { useState } from 'react'
import { Box, Button, Card, CardContent, Stack, Typography } from '@mui/material'
import QRCodeSVG from 'qrcode.react'

export default function Invite({ joinSessionLink }) {
  const [copied, setCopied] = useState(false)
  return (
    <Box paddingBottom={9} sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 'calc(100vh - 200px)' }}>
      <Card sx={{ borderRadius: 2, width: 'fit-content', backgroundColor: 'primary.main' }}>
        <CardContent>
          <Stack justifyContent="center" alignItems="center" spacing={2}>
            <Typography variant="h6" color="white">
              Join the fun!
            </Typography>
            <QRCodeSVG value={joinSessionLink} fgColor="white" bgColor="transparent" />
            <Button
              variant="outlined"
              sx={{ color: 'white', borderColor: 'white' }}
              onClick={() => {
                try {
                  navigator.clipboard.writeText(joinSessionLink)
                } catch (e) {
                  // clipboard unavailable
                }
                setCopied(true)
                window.setTimeout(() => setCopied(false), 2000)
              }}
            >
              {copied ? 'Link copied!' : 'Copy link'}
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  )
}
