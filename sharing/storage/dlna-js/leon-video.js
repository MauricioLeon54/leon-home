// LEÓN Home movie layout for Gerbera's JavaScript layout, loaded after its common.js.
// Every video goes into one "Películas → Todas las películas" list with its folder.jpg poster.
// Replaces common.js addVideo because Gerbera 2.4 adds a "Year" folder (file dates, not
// release years) even when that box is disabled. Gerbera runs Duktape: ES5 syntax only.
function leonBox(boxSetup, key) {
  return {
    id: boxSetup[key].id,
    title: boxSetup[key].title,
    objectType: OBJECT_TYPE_CONTAINER,
    upnpclass: boxSetup[key].class,
    upnpShortcut: boxSetup[key].upnpShortcut,
    metaData: [],
  };
}

function addVideo(obj, cont, rootPath, containerType) {
  var boxSetup = config['/import/scripting/virtual-layout/boxlayout/box'];
  var video = leonBox(boxSetup, BK_videoRoot);
  video.metaData[M_CONTENT_CLASS] = [UPNP_CLASS_VIDEO_ITEM];
  return [addCdsObject(obj, addContainerTree([video, leonBox(boxSetup, BK_videoAll)]))];
}
