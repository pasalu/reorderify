/**
 * This is an example of a basic node.js script that performs
 * the Authorization Code oAuth2 flow to authenticate against
 * the Spotify Accounts.
 *
 * For more information, read
 * https://developer.spotify.com/web-api/authorization-guide/#authorization_code_flow
 */

var express = require('express'); // Express web server framework
var request = require('request'); // "Request" library
var cors = require('cors');
var querystring = require('querystring');
var cookieParser = require('cookie-parser');
var fs = require('fs');

// Client id and secret stored in .env file.
var client_id = process.env.client_id;
var client_secret = process.env.client_secret;
var port = process.env.port || '8888';
var redirect_uri = `http://localhost:${port}/callback`; // Your redirect uri
let global_access_token = '';
const STARRED_PLAYLIST_NAME = "Starred";
const BACKUP_PLAYLIST_SUFFIX = "Reordered";

/**
 * Generates a random string containing numbers and letters
 * @param  {number} length The length of the string
 * @return {string} The generated string
 */
var generateRandomString = function(length) {
  var text = '';
  var possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  for (var i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
};

var stateKey = 'spotify_auth_state';

var app = express();

app.use(express.static(__dirname + '/public'))
   .use(cors())
   .use(cookieParser());

app.get('/login', function(req, res) {

  var state = generateRandomString(16);
  res.cookie(stateKey, state);

  // your application requests authorization
  var scope = 'user-read-private user-read-email playlist-read-private playlist-modify-public playlist-modify-private';
  res.redirect('https://accounts.spotify.com/authorize?' +
    querystring.stringify({
      response_type: 'code',
      client_id: client_id,
      scope: scope,
      redirect_uri: redirect_uri,
      state: state
    }));
});

app.get('/callback', function(req, res) {

  // your application requests refresh and access tokens
  // after checking the state parameter

  var code = req.query.code || null;
  var state = req.query.state || null;
  var storedState = req.cookies ? req.cookies[stateKey] : null;

  if (state === null || state !== storedState) {
    res.redirect('/#' +
      querystring.stringify({
        error: 'state_mismatch'
      }));
  } else {
    res.clearCookie(stateKey);
    var authOptions = {
      url: 'https://accounts.spotify.com/api/token',
      form: {
        code: code,
        redirect_uri: redirect_uri,
        grant_type: 'authorization_code'
      },
      headers: {
        'Authorization': 'Basic ' + (new Buffer(client_id + ':' + client_secret).toString('base64'))
      },
      json: true
    };

    request.post(authOptions, function(error, response, body) {
      if (!error && response.statusCode === 200) {
        var access_token = body.access_token,
            refresh_token = body.refresh_token;

        global_access_token = access_token;

        var options = {
          url: 'https://api.spotify.com/v1/me',
          headers: { 'Authorization': 'Bearer ' + access_token },
          json: true
        };

        // use the access token to access the Spotify Web API
        request.get(options, function(error, response, body) {
          console.log(body);
        });

        // we can also pass the token to the browser to make requests from there
        res.redirect('/#' +
          querystring.stringify({
            access_token: access_token,
            refresh_token: refresh_token
          }));
      } else {
        res.redirect('/#' +
          querystring.stringify({
            error: 'invalid_token'
          }));
      }
    });
  }
});

app.get('/refresh_token', function(req, res) {

  // requesting access token from refresh token
  var refresh_token = req.query.refresh_token;
  var authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    headers: { 'Authorization': 'Basic ' + (new Buffer(client_id + ':' + client_secret).toString('base64')) },
    form: {
      grant_type: 'refresh_token',
      refresh_token: refresh_token
    },
    json: true
  };

  request.post(authOptions, function(error, response, body) {
    if (!error && response.statusCode === 200) {
      var access_token = body.access_token;
      res.send({
        'access_token': access_token
      });
    }
  });
});

app.get('/get_playlists', function(request, result) {
  // get_playlists will be called when the page is refreshed so we need to re-save the access token.
  global_access_token = request.query.access_token;

  getAllPlaylists(global_access_token).then((playlists) => {
    result.send({playlists: playlists});
  });
});

app.get('/reorder', function(request, result) {
  let access_token = global_access_token;
  let name = request.query.playlist.name;
  let isDryRun = request.query.isDryRun === 'true';
  let playlistDetails = {
    originalPlaylistId: request.query.playlist.id,
    total: parseInt(request.query.playlist.totalTracks),
    snapshotId: request.query.playlist.snapshotId
  };

  if (isDryRun) {
    createBackupPlaylist(access_token, name).then((backupPlaylistId) => {
        playlistDetails.backupPlaylistId = backupPlaylistId;

        return playlistDetails;
    }).then((playlistDetails) => {
      return getAllTracksFromPlaylist(access_token, playlistDetails).then((tracks) => {
        playlistDetails.tracks = tracks;

        return playlistDetails;
      });
    }).then((playlistDetails) => {
      return addAllTracksToPlaylist(access_token, playlistDetails.tracks.slice(0, 10), playlistDetails.backupPlaylistId).then(() => {
        return playlistDetails;
      });
    }).then((playlistDetails) => {
      return reverseTracks(access_token, playlistDetails.backupPlaylistId, playlistDetails.tracks.slice(0, 10)).then(() => {
        const responseString = `All tracks in backup playlist ${getBackupPlaylistName(name)} reversed`;

        console.log(responseString);
        result.send(responseString);

        return playlistDetails;
      });
    }).catch((error) => {
      console.error(error);
      result.status(500).send(error);
    });
  } else {
    getAllTracksFromPlaylist(access_token, playlistDetails).then((tracks) => {
      playlistDetails.tracks = tracks;

      return playlistDetails;
    }).then((playlistDetails) => {
      return reverseTracks(access_token, playlistDetails.originalPlaylistId, playlistDetails.tracks).then(() => {
        const responseString = `All tracks in ${name} reversed?`;

        console.log(responseString);
        result.send(responseString);

        return playlistDetails;
      });
    }).catch((error) => {
      console.error(error);
      result.status(500).send(error);
    });
  }
});

/**
 * Fetch a paged list of playlists.
 * @param {String} access_token 
 * @param {String} url The URL to fetch playlists from.
 * @returns Playlist data.
 */
var getPlaylists = function(access_token, url) {
  return new Promise((resolve, reject) => {
    let playlistOptions = {
        url: url,
        headers: { 'Authorization': 'Bearer ' + access_token },
        json: true
    };

    request.get(playlistOptions, function (error, response, body) {
      if (error || (response.statusCode != 200 && response.statusCode != 201)) {
        let message = error || response.statusMessage;
        reject({
          completed: false,
          message: `Error getting playlists ${message}`
        });
      } else {
        resolve({
          completed: true,
          message: body
        });
      }
    });
  });
}

/**
 * Get all available playlists.
 * @param {String} access_token 
 * @returns An array of playlist objects sorted by name.
 */
var getAllPlaylists = function(access_token) {
  return new Promise(async (resolve, reject) => {
    let url = 'https://api.spotify.com/v1/me/playlists?offset=0&limit=50';
    let items = [];

    while (url) {
      var result = await getPlaylists(access_token, url).catch((message) => {
        return message;
      });

      if (result.completed) {
        url = result.message.next; // next URL will be null if we've reached the last set of playlists.
        items.push(...result.message.items);
      } else {
        return reject(result.message);
      }
    }

    items.sort((a, b) => a.name.localeCompare(b.name));

    return resolve(items);
  });
}

/**
 * Gets information about the specified playlist.
 * @param {String} playlists The JSON body of a call to get a user's playlists.
 * @param {String} playlistName The name of the playlist.
 * @returns {Object} The playlist id, number of tracks, and snapshot id.
 */
var extractPlaylistDetails = function(playlists, playlistName) {
  return new Promise((resolve, reject) => {
    for (let i = 0; i < playlists.length; i++) {
      const playlist = playlists[i];
      
      if (playlist["name"] === playlistName) {
        let playlistDetails = {
          originalPlaylistId: playlist.id,
          total: playlist.tracks.total,
          snapshotId: playlist.snapshot_id
        }
        resolve(playlistDetails);
      }
    }

    return reject(`No playlist matching name ${playlistName}`);
  });
};

var getBackupPlaylistName = function(name) {
  return name + BACKUP_PLAYLIST_SUFFIX;
}

/**
 * Create a backup playlist so we don't have to modify the original playlist.
 * @param {String} accessToken Current API access token.
 * @param {String} name The name of the original playlist. Will be prefixed to the backup playlist name.
 * @returns {String} The id of the newly created playlist.
 */
var createBackupPlaylist = function(access_token, name) {
  const DESCRIPTION = "A copy of the playlist which shows what it would be like after it was reordered. Created " + new Date().toString();

  const data = {
    name: getBackupPlaylistName(name),
    description: DESCRIPTION,
    public: false, // Not working for some reason. It's always public.
    collaborative: false
  };
  const options = {
    url: 'https://api.spotify.com/v1/me/playlists',
    headers: { 'Authorization': `Bearer ${access_token}` },
    body: data,
    json: true,
  };

  return new Promise((resolve, reject) => {
    request.post(options, function(error, response, body) {
      if (error || (response.statusCode != 200 && response.statusCode != 201)) {
        let message = error || response.statusMessage;
        reject(`Error Creating backup playlist error message: ${message}`);
      } else {
        console.log(`Successfully created backup playlist with ID ${body.id}`);
        resolve(body.id);
      }
    });
  });
}

/**
 * Get track id's from the specified playlist.
 * @param {String} access_token 
 * @param {string} playlistId Id of the playlist to search.
 * @param {Number} offset Position within the playlist to start searching for tracks.
 * @param {Number} limit Maximum number of tracks to return.
 * @returns {Array} An array of Spotify track URI's.
 */
var getTracksFromPlaylist = function(access_token, playlistId, offset, limit) {
  const FIELDS = "items.track.uri";
  const options = {
    url: `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=${limit}&offset=${offset}&fields=${FIELDS}`,
    headers: { 'Authorization': `Bearer ${access_token}` },
    market: "US", // TODO: Get the country code dynamically https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile
  };

  return new Promise((resolve, reject) => {
    request.get(options, function(error, response, body) {
      if (error || (response.statusCode != 200 && response.statusCode != 201)) {
        let message = error || response.statusMessage;
        reject(`Error fetching playlist tracks: ${message}`);
      } else {
        let bodyJson = JSON.parse(body);

        var tracks = [];

        for(let i = 0; i < bodyJson.items.length; i++) {
          let track = bodyJson["items"][i]["track"]["uri"];

          // Local tracks like "spotify:local:Eminem:Infinite:Scary+Movie:220" cannot be added
          // with the api, so just exclude them.
          if (track.startsWith("spotify:track:")) {
            tracks.push(track);
          } else {
            console.log(`Not using track "${track}"`);
          }
        }

        resolve(tracks);
      }
    });
  })
}

/**
 * Get all tracks from specified playlist.
 * @param {String} access_token 
 * @param {Object} playlistDetails Information about the playlist from which we are getting all tracks from.
 * @returns A Promise containing an array with all non local tracks.
 */
var getAllTracksFromPlaylist = function(access_token, playlistDetails) {
  const LIMIT = 50;
  var promises = [];

  for (let i = 0; i < playlistDetails.total; i += 50) {
    promises.push(getTracksFromPlaylist(access_token, playlistDetails.originalPlaylistId, i, LIMIT));
  }

  return new Promise((resolve, reject) => {
    Promise.all(promises)
      .then((tracks) => {
        // The result of these promises will be a 2D array of tracks, so we need to flatten them.
        var allTracks = tracks.flat();
        resolve(allTracks);
      }).catch(reject);
  });
}

/**
 * Add a maximum of 100 tracks to the specified playlist.
 * @param {String} access_token 
 * @param {String[]} tracks The Spotify URIs of the tracks to add.
 * @param {String} playlistId The id of the playlist that's getting the new tracks.
 * @returns A promise with the error message if the operation fails, resolve otherwise.
 */
var addTracksToPlaylist = async function(access_token, tracks, playlistId) {
  const options = {
    url: `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
    headers: { 'Authorization': `Bearer ${access_token}` },
    json: true,
    body: {uris: tracks}
  }

  return new Promise((resolve, reject) => {
    request.post(options, (error, response, body) => {
      if (error || (response.statusCode != 200 && response.statusCode != 201)) {
        let message = error || response.statusMessage + " " + body.error.message;
        reject(`Error adding tracks to playlist ${message}`);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Add all tracks to the playlist.
 * @param {String} access_token 
 * @param {String[]} tracks The Spotify URIs of the tracks to add.
 * @param {String} playlistId The id of the playlist that's getting the new tracks.
 * @returns A promise with the error message if the operation fails.
 */
var addAllTracksToPlaylist = async function(access_token, tracks, playlistId) {
  const NUMBER_OF_SONGS_TO_ADD = 100;
  const RETRIES = 3;
  let i = 0;
  let tries = 0;

  while (i < tracks.length) {
    const result =
      await addTracksToPlaylist(access_token, tracks.slice(i, i + NUMBER_OF_SONGS_TO_ADD), playlistId, 3).catch(() => {
        // This return is only for the catch block. The value will be set to result.
        return false;
      });

    if (result === false) {
      tries++;

      if (tries >= RETRIES) {
        return Promise.reject(`Unable to add tracks at index ${i} to playlist.`);
      } 
    } else {
      i += NUMBER_OF_SONGS_TO_ADD;
      tries = 0;
    }
  }

  return Promise.resolve();
}

/**
 * Move the specified track.
 * 
 * @param {String} access_token 
 * @param {String} playlistId The Spotify Id of the playlist.
 * @param {String} trackId The Spotify Id of the track.
 * @param {Number} currentLocation The zero based index of the track in the playlist.
 * @param {Number} destinationLocation The zero based index the track should be moved to.
 * @param {String} snapshotId The snapshot version of the playlist against which to make these changes.
 */
var moveTrack = function(access_token, playlistId, trackId, currentLocation, destinationLocation, snapshotId) {
  return new Promise((resolve, reject) => {
    const options = {
      url: `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
      headers: { 'Authorization': `Bearer ${access_token}` },
      json: true,
      body: {
        uris: trackId,
        range_start: currentLocation,
        insert_before: destinationLocation,
        range_length: 1,
      }
    };

    if (snapshotId != "") {
      options.body.snapshotId = snapshotId;
    }

    request.put(options, (error, response, body) => {
      if (error || (response.statusCode != 200 && response.statusCode != 201)) {
        let message = error || response.statusMessage + " " + body?.error?.message;
        reject({
          completed: false,
          message: `Error moving track to the bottom: ${message}`
        });
      } else {
        resolve({
          completed: true,
          message: body.snapshot_id
        });
      }
    });
  });
}

/**
 * Reverse the order of the tracks in the playlist.
 * @param {String} access_token 
 * @param {String} playlistId The id of the playlist.
 * @param {String[]} tracks The spotify id's of the tracks.
 */
var reverseTracks = function(access_token, playlistId, tracks) {
  return new Promise(async (resolve, reject) => {
    const RETRIES = 3;
    let tries = 0;
    let i = 0;
    let snapshotId = "";

    console.log(`Reversing ${tracks.length} tracks`);

    /**
     * Reverse tracks by inserting top track to the bottom and then shifting bottom up by 1 each time.
     * 1    2    3    4    5
     * 2    3    4    5    4
     * 3 -> 4 -> 5 -> 3 -> 3
     * 4    5    2    2    2
     * 5    1    1    1    1
     */
    while (i < tracks.length) {
      console.log(`Moving ${tracks[i]} to ${tracks.length - i}`);
      var result = await moveTrack(access_token, playlistId, tracks[i], 0, tracks.length - i, snapshotId).catch((message) => {
        return message;
      });

      if (!result.completed) {
        tries++;

        if (tries >= RETRIES) {
          return reject(result.message);
        }
      } else {
        i++;
        tries = 0;
        snapshotId = result.message;
      }
    }

    return resolve();
  });
}

console.log(`Reorderify started and is listening on ${port}`);
app.listen(port);
