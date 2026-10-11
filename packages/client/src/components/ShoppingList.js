import { Box, List, ListItem, Typography } from '@mui/material'

export default function ShoppingList({ shoppingList }) {
  const items = shoppingList || []
  return (
    <Box paddingBottom={9}>
      {items.length === 0 ? (
        <Typography color="text.secondary" sx={{ p: 2 }}>
          The shopping list appears once the plan is ready.
        </Typography>
      ) : (
        <List>
          {items.map(({ name, amount, unit }, i) => (
            <ListItem key={`${name}-${i}`}>
              {amount} {unit} {name}
            </ListItem>
          ))}
        </List>
      )}
    </Box>
  )
}
