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
          getStarredPlaylistId(body).then(starredPlaylistId => {
            console.log(`Starred Playlist Id: ${starredPlaylistId}`);
            return starredPlaylistId;
          }).then((starredPlaylistId) => {
            createBackupPlaylist(access_token);
            return starredPlaylistId;
          }).then((starredPlaylistId) => {
            let tracks = getTracksFromPlaylist(access_token, starredPlaylistId);
            return tracks;
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
 * Returns the playlist ID of the starred playlist.
 * @param {String} playlists The JSON body of a call to get a user's playlists.
 */
var getStarredPlaylistId = function(playlists) {
  return new Promise((resolve, reject) => {
    for (let i = 0; i < playlists["items"].length; i++) {
      const playlist = playlists["items"][i];
      
      if (playlist["name"] === STARRED_PLAYLIST_NAME) {
        resolve(playlist["id"]);
      }
    }

    return reject(`No playlist matching name ${STARRED_PLAYLIST_NAME}`);
  });
};

/**
 * Create a backup playlist so we don't have to modify the original starred playlist.
 * @param {String} accessToken Curernt API access token.
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
        console.log("Successfully created backup playlist");
        resolve(body.name);
      }
    });
  });
}

/**
 * Using the starred playlist as a base, add tracks to the new playlist with the last track as the first.
 * @param {String} access_token 
 */
var getTracksFromPlaylist = function(access_token, starredPlaylistId) {
  // Get tracks from starred playlist.
  const LIMIT = 3;
  const OFFSET = 0;
  const FIELDS = "items.track.uri";
  const options = {
    url: `https://api.spotify.com/v1/playlists/${starredPlaylistId}/tracks?limit=${LIMIT}&offset=${OFFSET}&fields=${FIELDS}`,
    headers: { 'Authorization': `Bearer ${access_token}` },
    market: "US", // TODO: Get the country code dynamically https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile
  };

  return new Promise((resolve, reject) => {
    request.get(options, function(error, response, body) {
      if (error) {
        reject(`Error fetching playlist tracks ${error}`);
      } else {
        console.log(`Response ${response}`);
        console.log(`Body: ${body}`);
        let bodyJson = JSON.parse(body);

        var tracks = [];

        for(let i = 0; i < bodyJson.items.length; i++) {
          tracks.push(bodyJson["items"][i]["track"]["uri"]);
        }

        console.log(`Tracks: ${tracks}`);
        resolve(tracks);
      }
    });
  })
}
app.listen(8888);
