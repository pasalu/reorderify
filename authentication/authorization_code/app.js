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

// Hiding client info in JSON file because it should be secret.
let client_info = JSON.parse(fs.readFileSync('client_info.json', 'utf-8'));

var client_id = client_info['client_id']; // Your client id
var client_secret = client_info['client_secret']; // Your secret
var redirect_uri = 'http://localhost:8888/callback'; // Your redirect uri
const STARRED_PLAYLIST_NAME = "Starred";

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
  var scope = 'user-read-private user-read-email playlist-modify-public playlist-modify-private';
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

        var options = {
          url: 'https://api.spotify.com/v1/me',
          headers: { 'Authorization': 'Bearer ' + access_token },
          json: true
        };

        // use the access token to access the Spotify Web API
        request.get(options, function(error, response, body) {
          console.log(body);
        });

        // Add GET https://api.spotify.com/v1/me/playlists here!
        var playlistOptions = {
            url: 'https://api.spotify.com/v1/me/playlists',
            headers: { 'Authorization': 'Bearer ' + access_token },
            json: true
        };

        request.get(playlistOptions, function (error, response, body) {
          extractPlaylistDetails(body, STARRED_PLAYLIST_NAME).then(playlistDetails => {
            return playlistDetails;
          }).then((playlistDetails) => {
            return createBackupPlaylist(access_token).then((backupPlaylistId) => {
              playlistDetails.backupPlaylistId = backupPlaylistId;
              return playlistDetails;
            });
          }).then((playlistDetails) => {
            return getAllTracksFromPlaylist(access_token, playlistDetails).then((tracks) => {
              playlistDetails.tracks = tracks;
              return playlistDetails;
            });
          }).then((playlistDetails) => {
            return addAllTracksToPlaylist(access_token, playlistDetails.tracks, playlistDetails.backupPlaylistId);
          }).catch(console.log);
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

/**
 * Gets information about the specified playlist.
 * @param {String} playlists The JSON body of a call to get a user's playlists.
 * @param {String} playlistName The name of the playlist.
 * @returns {Object} The playlist id and number of tracks.
 */
var extractPlaylistDetails = function(playlists, playlistName) {
  return new Promise((resolve, reject) => {
    for (let i = 0; i < playlists["items"].length; i++) {
      const playlist = playlists["items"][i];
      
      if (playlist["name"] === playlistName) {
        let playlistDetails = {
          originalPlaylistId: playlist.id,
          total: playlist.tracks.total
        }
        resolve(playlistDetails);
      }
    }

    return reject(`No playlist matching name ${STARRED_PLAYLIST_NAME}`);
  });
};

/**
 * Create a backup playlist so we don't have to modify the original starred playlist.
 * @param {String} accessToken Current API access token.
 * @returns {String} The id of the newly created playlist.
 */
var createBackupPlaylist = function(access_token) {
  const DESCRIPTION = "A clone of the playlist which shows what it would be like after it was reordered. Created " + new Date().toString();

  const data = {
    "name": "StarredReordered",
    "description": DESCRIPTION,
    "public": false
  };
  const options = {
    url: 'https://api.spotify.com/v1/me/playlists',
    headers: { 'Authorization': `Bearer ${access_token}` },
    body: data,
    json: true,
  };

  return new Promise((resolve, reject) => {
    request.post(options, function(error, response, body) {
      if (body.error) {
        reject(`Error Creating backup playlist error message: ${body.error.message}`);
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
      if (error) {
        reject(`Error fetching playlist tracks ${error}`);
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
 * @param {Number} position Where in the playlist to add the tracks
 */
var addTracksToPlaylist = function(access_token, tracks, playlistId, position) {
  const options = {
    url: `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
    headers: { 'Authorization': `Bearer ${access_token}` },
    json: true,
    body: {uris: tracks}
  }

  return new Promise((resolve, reject) => {
    request.post(options, (error, response, body) => {
      if (error || (response.statusCode != 200 && response.statusCode != 201)) {
        reject(error || response.statusMessage + " " + body.error.message);
      } else {
        resolve();
      }
    });
  });
}

var addAllTracksToPlaylist = function(access_token, tracks, playlistId) {
  const NUMBER_OF_SONGS_TO_ADD = 100;
  let promises = [];

  for (let i = 0; i < tracks.length; i += NUMBER_OF_SONGS_TO_ADD) {
    promises.push(
      addTracksToPlaylist(access_token, tracks.slice(i, i + NUMBER_OF_SONGS_TO_ADD), playlistId, 0)
    );
  }

  return new Promise((resolve, reject) => {
    Promise.all(promises)
      .then((tracks) => {
        resolve();
      }).catch(reject);
  });
}
app.listen(8888);
