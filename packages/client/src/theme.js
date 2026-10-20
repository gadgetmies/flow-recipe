import { createTheme } from '@mui/material'
import { pink, purple } from '@mui/material/colors'

const theme = createTheme({
  palette: {
    background: {
      default: '#e7ecf8',
    },
    primary: pink,
    secondary: purple,
  },
})

export default theme
