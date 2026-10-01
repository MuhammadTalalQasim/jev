const fs = require('fs')
const path = require('path')

function loadEnv() {
  const out = {}
  const p = path.join(__dirname, '..', '.env.local')
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m) out[m[1].trim()] = m[2].trim().replace(/^"|"$/g, '')
  }
  return out
}

async function main() {
  const env = loadEnv()
  const res = await fetch('https://openrouter.ai/api/alpha/decisions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'typesafe/jev-1.13',
      state: { user_message: "What are today's POS sales?" },
      questions: {
        intent: {
          type: 'choice',
          instructions: 'Which action matches?',
          criteria: {
            today_pos: 'Today POS sales',
            greeting: 'Greeting',
            other: 'Other',
          },
        },
      },
    }),
  })
  const text = await res.text()
  console.log('status', res.status)
  console.log(text.slice(0, 800))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
