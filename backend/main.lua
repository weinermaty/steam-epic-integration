local millennium = require("millennium")
local logger = require("logger")

local function shell_quote(str)
    if not str then return "''" end
    return "'" .. tostring(str):gsub("'", "'\\''") .. "'"
end

local function run_helper(cmd, arg)
    local backend_dir = MILLENNIUM_PLUGIN_SECRET_BACKEND_ABSOLUTE or "."
    local script = backend_dir .. "/epic_helper.py"
    local full_cmd = "python3 " .. shell_quote(script) .. " " .. shell_quote(cmd)
    if arg and arg ~= "" then
        full_cmd = full_cmd .. " " .. shell_quote(arg)
    end
    local handle = io.popen(full_cmd .. " 2>/dev/null")
    if not handle then
        return '{"ok":false,"error":"Failed to spawn epic_helper.py"}'
    end
    local output = handle:read("*a")
    handle:close()
    if not output or output == "" then
        return '{"ok":false,"error":"Empty output from epic_helper.py"}'
    end
    return output
end

function GetFreeGames()
    return run_helper("free", "")
end

function GetEpicLibrary()
    return run_helper("library", "")
end

function SyncSteamShortcuts()
    return run_helper("sync", "")
end

function LaunchOrInstallEpicGame(app_name)
    return run_helper("launch", app_name or "")
end

function AuthenticateEpic(auth_code)
    return run_helper("auth", auth_code or "")
end

return {
    on_load = function()
        logger:info("steam-epic-integration backend loaded")
        millennium.ready()
    end,
    on_frontend_loaded = function()
        logger:info("steam-epic-integration frontend connected")
    end,
    on_unload = function()
        logger:info("steam-epic-integration unloading")
    end
}
