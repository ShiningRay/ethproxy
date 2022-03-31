import Server from "../src/server"

test('Server#host', () => {
  const server = new Server({ name: 'test', url: 'http://localhost:3000' })
  expect(server.host).toBe('localhost:3000')
})
