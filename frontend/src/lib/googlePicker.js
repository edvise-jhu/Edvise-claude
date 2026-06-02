const SCOPES = 'https://www.googleapis.com/auth/drive.readonly'
const MIME_TYPES = [
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
].join(',')

function loadPickerApi() {
  return new Promise((resolve, reject) => {
    const start = () => {
      if (!window.gapi?.load) {
        reject(new Error('Google API not loaded. Check index.html scripts and network.'))
        return
      }
      window.gapi.load('picker', resolve)
    }
    if (window.gapi?.load) start()
    else {
      let n = 0
      const t = setInterval(() => {
        n += 1
        if (window.gapi?.load) {
          clearInterval(t)
          start()
        } else if (n > 200) {
          clearInterval(t)
          reject(new Error('Google API not loaded. Check index.html scripts and network.'))
        }
      }, 50)
    }
  })
}

export async function openGooglePicker() {
  return new Promise((resolve, reject) => {
    loadPickerApi().then(() => {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
        scope: SCOPES,
        callback: (tokenResponse) => {
          if (tokenResponse.error) return reject(tokenResponse.error)

          const picker = new window.google.picker.PickerBuilder()
            .setAppId(import.meta.env.VITE_GOOGLE_APP_ID)
            .setOAuthToken(tokenResponse.access_token)
            .setDeveloperKey(import.meta.env.VITE_GOOGLE_API_KEY)
            .addView(
              new window.google.picker.DocsView()
                .setIncludeFolders(false)
                .setMimeTypes(MIME_TYPES)
            )
            .setCallback(async (data) => {
              if (data.action === window.google.picker.Action.PICKED) {
                const file = data.docs[0]
                resolve({
                  fileId: file.id,
                  fileName: file.name,
                  mimeType: file.mimeType,
                  accessToken: tokenResponse.access_token,
                })
              } else if (data.action === window.google.picker.Action.CANCEL) {
                reject(new Error('cancelled'))
              }
            })
            .build()

          picker.setVisible(true)
        },
      })
      client.requestAccessToken()
    }).catch(reject)
  })
}

export async function downloadDriveFile(fileId, accessToken) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!res.ok) throw new Error('Could not download file from Google Drive')
  return res.blob()
}
