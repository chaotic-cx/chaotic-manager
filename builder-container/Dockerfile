FROM archlinux:latest

# Set up a basic Arch container with Chaotic-AUR enabled
# makepkg flags: https://github.com/chaotic-aur/toolbox/pull/105
RUN curl -o /etc/pacman.d/mirrorlist "https://archlinux.org/mirrorlist/?country=DE&protocol=https&use_mirror_status=on" && \
    sed -i 's/^#//' /etc/pacman.d/mirrorlist && echo -e "RemoteFileSigLevel = Never\nParallelDownloads = 10" >> /etc/pacman.conf && \
    echo -e "[multilib]\nInclude = /etc/pacman.d/mirrorlist" >> /etc/pacman.conf && \
    pacman -Sy --noconfirm archlinux-keyring && \
    pacman -Su --noconfirm base-devel namcap sudo git && \
    pacman -Scc --noconfirm && \
    useradd -m builder && usermod -aG wheel builder && \
    printf '%s\n%s' '%wheel ALL=(ALL) NOPASSWD:ALL' 'Defaults runcwd=*' >> /etc/sudoers

COPY ./entry_point.sh ./build.sh ./interfere.sh ./add-database.sh ./util.shlib ./auto-database-remove.sh ./parse-database.awk /
RUN chmod +x /entry_point.sh /build.sh /add-database.sh /interfere.sh /auto-database-remove.sh

ENTRYPOINT ["/entry_point.sh"]
