local json = require("json")

local AO_PROCESS_ID = os.getenv("AO_PROCESS_ID") or "czYYWP96oA9xJJ1FMGUx_If144G7_EUL6yVIer30dQw"

-- Initial state
state = state or {
    childCounter = 0,
    children = {},
    moduleId = os.getenv("AO_MODULE_ID") or "JArYBF-D8q2OmZ4Mok00sD2Y_6SYEQ7Hjx-6VZ_jl3g"
}

local function log(msg)
    print("[ParentContract][" .. os.date("%Y-%m-%d %H:%M:%S") .. "] " .. msg)
end


-- Sapwn child process 
Handlers.add(
    "Spawn-Child",
    Handlers.utils.hasMatchingTag("Action", "Spawn-Child"),
    function(msg)
        local userId = msg.Tags and msg.Tags["User-ID"]
        if not userId then
            ao.send({
                Target = msg.From,
                Data = json.encode({ Success = false, message = "User-ID required" })
            })
            return
        end

        local depositAddress = msg.Tags and msg.Tags["Deposit-Address"] or ""
        if depositAddress == "" then
            log("WARNING: No deposit address provided; registration will proceed without it.")
        end

        local derivationIndex = msg.Tags and msg.Tags["Derivation-Index"] or "0" -- Default to "0" if not provided
        local parentId = ao.id

        local authority = "fcoN_xJeisVsPXA-trzVAuIiqO3ydLQxM-L4XbrQKzY"
        local spawnArgs = {
            Tags = {
                { name = "Authority", value = authority },
                { name = "User-ID", value = userId },
                { name = "Deposit-Address", value = depositAddress },
                { name = "Parent", value = parentId }
            }
        }

        local success, spawnResponse = pcall(function()
            return ao.spawn(state.moduleId, spawnArgs).receive()
        end)
        if not success or not spawnResponse then
            ao.send({
                Target = msg.From,
                Data = json.encode({ Success = false, message = "Spawn error" })
            })
            return
        end

        local childProcessId = nil
        if spawnResponse.TagArray then
            for _, tag in ipairs(spawnResponse.TagArray) do
                if tag.name == "Process" and type(tag.value) == "string" and #tag.value == 43 then
                    childProcessId = tag.value
                    break
                end
            end
        end

        if not childProcessId then
            ao.send({
                Target = msg.From,
                Data = json.encode({ Success = false, message = "Failed to extract child process ID" })
            })
            return
        end

        log("Child process spawned with ID: " .. childProcessId)

        -- Register child process 

        local registrationData = {
            Success = true,
            message = "Registering child process",
            childProcessId = childProcessId,
            userId = userId,
            parentId = parentId,
            depositAddress = depositAddress
        }
        local registrationTags = {
            { name = "Action", value = "Register-Process" },
            { name = "Parent", value = parentId },
            { name = "Process-ID", value = childProcessId },
            { name = "User-ID", value = userId },
            { name = "Deposit-Address", value = depositAddress },
            { name = "Derivation-Index", value = derivationIndex }
        }
        log("DEBUG: Sending registration with data: " .. json.encode(registrationData) .. " and tags: " .. json.encode(registrationTags))

        ao.send({
            Target = AO_PROCESS_ID,
            Data = json.encode(registrationData),
            Tags = registrationTags
        })
        log("Sent registration message to ledger (" .. AO_PROCESS_ID .. ") for child process: " .. childProcessId)

        ao.send({
            Target = msg.From,
            Data = json.encode({
                Success = true,
                message = "Child process spawned and registration initiated",
                childProcessId = childProcessId
            }),
            Tags = {
                { name = "Action", value = "Spawned" },
                { name = "User-ID", value = userId },
                { name = "Deposit-Address", value = depositAddress },
                { name = "Process-ID", value = childProcessId },
                { name = "Derivation-Index", value = derivationIndex }
            }
        })
    end
)