FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY global.json ./
COPY backend/CampusNexa.Api/CampusNexa.Api.csproj backend/CampusNexa.Api/packages.lock.json ./backend/CampusNexa.Api/
COPY tests/RecoveryChecks/RecoveryChecks.csproj tests/RecoveryChecks/packages.lock.json ./tests/RecoveryChecks/
RUN dotnet restore tests/RecoveryChecks --locked-mode
COPY backend/CampusNexa.Api ./backend/CampusNexa.Api
COPY tests/RecoveryChecks ./tests/RecoveryChecks
RUN dotnet publish tests/RecoveryChecks -c Release --no-restore -o /checks
FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /checks
COPY --from=build /checks .
USER $APP_UID
ENTRYPOINT ["dotnet", "RecoveryChecks.dll"]
