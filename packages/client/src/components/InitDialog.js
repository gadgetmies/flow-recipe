import { useState } from 'react'
import { Button, Card, CardContent, FormControl, FormControlLabel, FormLabel, Grid2, Radio, RadioGroup, Stack, TextField, Typography } from '@mui/material'

export default function InitDialog({ name, setName, isSpectator: defaultIsSpectator, onJoin }) {
  const [isSpectator, setIsSpectator] = useState(defaultIsSpectator)
  return (
    <Grid2 container padding={2} direction="column" alignItems="center" style={{ minHeight: '100vh' }}>
      <Grid2>
        <Card>
          <CardContent>
            <Stack spacing={2}>
              <Typography gutterBottom variant="h5" component="div">
                Set your name
              </Typography>
              <TextField name="name" label="name" onChange={(e) => setName(e.target.value)} value={name} />
              <FormControl component="fieldset">
                <FormLabel component="legend">Participation</FormLabel>
                <RadioGroup
                  row
                  value={isSpectator === undefined ? '' : isSpectator ? 'spectate' : 'participate'}
                  onChange={(e) => setIsSpectator(e.target.value === 'spectate')}
                >
                  <FormControlLabel value="participate" control={<Radio />} label="Participate" />
                  <FormControlLabel value="spectate" control={<Radio />} label="Spectate" />
                </RadioGroup>
              </FormControl>
              <Button variant="contained" disabled={name === '' || isSpectator === undefined} onClick={() => onJoin({ name, isSpectator })}>
                Join
              </Button>
            </Stack>
          </CardContent>
        </Card>
      </Grid2>
    </Grid2>
  )
}
