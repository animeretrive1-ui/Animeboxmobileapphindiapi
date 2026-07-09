# Stream Extractor API

This project is a Vercel-ready API that extracts video stream URLs based on TMDB ID, Season, and Episode.

## Project Structure

- `api/index.js`: The serverless function handler.
- `lib/extractor.js`: Core logic for fetching and decoding streams.
- `public/index.html`: A simple frontend to test the API.

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file with your API keys:
   ```ini
   MY_SERIES_API_KEY=your_key_here
   TMDB_API_KEY=your_key_here
   ```

3. Run with Vercel CLI (recommended):
   ```bash
   npm i -g vercel
   vercel dev
   ```
   Then open http://localhost:3000

## Deployment

1. Push this repository to GitHub/GitLab/Bitbucket.
2. Import the project in Vercel.
3. Add the Environment Variables (`MY_SERIES_API_KEY`, `TMDB_API_KEY`) in the Vercel project settings.
4. Deploy!

## API Usage

**Endpoint:** `/api/extract`

**Query Parameters:**
- `tmdbId` (required)
- `season` (required)
- `episode` (required)
- `epname` (optional)

**Example:**
`GET /api/extract?tmdbId=61663&season=1&episode=1`
