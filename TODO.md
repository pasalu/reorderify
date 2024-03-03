# TODO
- See if there's a way to use snapshots to make sure that we don't partially modify the real playlist.
    - Save the snapshot id when we start modifying the playlists and then keep it until we mark it as done.
    - We want to make sure this is all or nothing.
    - Might have to wait and retry on API rate limit failure.
- Create a separate project stripping out unnecessary addons from sample Spotify project.
- Ask for a rate limit increase from Spotify.
- Figure out a way to publish this.
    - Make sure to fork and attribute code to spotify example on github.
- Add the ability to specify which playlist should be reordered.
- Make backup playlist private.
    - Not working for some reason.
- For the dry run, re-use the existing StarredClone since you cannot delete a playlist with the API.
- Why are we using a server? Couldn't we make all these requests on the client?

# DONE
- Should the user login using their account or can I just retrieve the playlist 
- Create separate new playlists that contain both old and reordered playlist. A dry run option.
- (No option to do this in API) Add a command line level tool to delete a playlist by name. 
- Show an error message when you're unable to connect to Spotify.
    - Probably on the first API call to get playlists.
- Solve issue with 502 (Bad Gateway) being returned from API.
    - Might be caused by too many requests at once.
        - Space out requests with random delay in between.
        - Requests to add songs to playlists must go in one order.
            - If we don't we'd have to keep track of where each song should go.
    - Try sending each song request individually to see if we get different failures.
- Fetch all playlists, not just the first 20 returned by the API.