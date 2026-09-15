export default async function handler(req, res) {
  const token = process.env.NOTION_API_KEY
  const databaseId = process.env.ENQUIRY_DB

  if (!token) {
    return res.status(500).json({
      test: 'FAILED',
      reason: 'NOTION_API_KEY missing from Vercel'
    })
  }

  if (!databaseId) {
    return res.status(500).json({
      test: 'FAILED',
      reason: 'ENQUIRY_DB missing from Vercel'
    })
  }

  try {
    const response = await fetch(
      `https://api.notion.com/v1/databases/${databaseId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': '2022-06-28'
        }
      }
    )

    const data = await response.json()

    return res.status(200).json({
      test: response.ok ? 'SUCCESS' : 'FAILED',
      notionStatus: response.status,
      databaseId,
      notionResponse: data
    })
  } catch (error) {
    return res.status(500).json({
      test: 'FAILED',
      reason: error.message
    })
  }
}
